// ============================================
// OpenSwarm - GraphQL Query Cost Analysis
// Created: 2026-04-14
// Purpose: Reflect resolver executions multiplied by alias/fragment-spread in the cost and reject over-limit queries before execution
// ============================================

import {
  GraphQLError,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import type { Plugin } from 'graphql-yoga';

/**
 * Representative cost (cost units) of expensive registry/issue mutations.
 * bulkRegisterEntities writes up to 100 entities, so a single field is charged a cost of 500.
 * autoLinkMemories performs embedding search + multiple links, so it gets the same budget.
 */
export const BULK_REGISTER_ENTITIES_COST = 500;
export const AUTO_LINK_MEMORIES_COST = 500;

/**
 * Registry CRUD mutations: bounded single-row writes. Priced below a bulk
 * register so a single-entity edit is never mistaken for a bulk write, but
 * high enough that aliasing them multiplies past the limit quickly — alias and
 * fragment spread are the multiplication vector this table defends against.
 */
export const REGISTER_ENTITY_COST = 100;

/**
 * Mapping of representative execution costs for top-level mutation root fields.
 * (DoD name: FIELD_COSTS — cost table for mutation/query root fields)
 */
export const FIELD_COSTS: Record<string, number> = {
  bulkRegisterEntities: BULK_REGISTER_ENTITIES_COST,
  autoLinkMemories: AUTO_LINK_MEMORIES_COST,
  registerEntity: REGISTER_ENTITY_COST,
  updateEntity: 80,
  removeEntity: 80,
  addEntityRelation: 60,
  removeEntityRelation: 60,
};

/** Default query cost cap */
export const DEFAULT_QUERY_COST_LIMIT = 500;

/** Recursion depth cap against fragment cycles/excessive nesting spread (prevents runaway stack) */
const MAX_EXPANSION_DEPTH = 100;

export interface QueryCostOptions {
  maximumCost?: number;
  fieldCosts?: Record<string, number>;
}

function readMaximumCostFromEnv(): number | undefined {
  const raw = process.env.OPENSWARM_GRAPHQL_MAX_QUERY_COST;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Base cost of one field. Among top-level mutation root fields, registered expensive mutations are
 * replaced by their representative execution cost. An alias is a separate Field node, so each is charged individually.
 */
function fieldCost(
  node: FieldNode,
  fieldCosts: Record<string, number>,
  inMutationRoot: boolean,
): { cost: number; isExpensiveMutation: boolean } {
  if (inMutationRoot) {
    const mutationCost = fieldCosts[node.name.value];
    if (mutationCost !== undefined) return { cost: mutationCost, isExpensiveMutation: true };
  }
  return { cost: 1, isExpensiveMutation: false };
}

/**
 * Total cost of a selection set. FragmentSpread/InlineFragment spread at the point of use —
 * spreading the same fragment N times runs its resolvers N times, so the cost is multiplied by N.
 */
function costOfSelectionSet(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  fieldCosts: Record<string, number>,
  inMutationRoot: boolean,
  depth: number,
): number {
  if (depth > MAX_EXPANSION_DEPTH) return Number.POSITIVE_INFINITY;

  let cost = 0;
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case 'Field': {
        const { cost: fc, isExpensiveMutation } = fieldCost(selection, fieldCosts, inMutationRoot);
        cost += fc;
        // The sub-selectionSet of an expensive mutation ({ id } etc.) is included in the representative cost — not added separately
        if (!isExpensiveMutation && selection.selectionSet) {
          cost += costOfSelectionSet(selection.selectionSet, fragments, fieldCosts, false, depth + 1);
        }
        break;
      }
      case 'InlineFragment': {
        cost += costOfSelectionSet(selection.selectionSet, fragments, fieldCosts, inMutationRoot, depth + 1);
        break;
      }
      case 'FragmentSpread': {
        const fragment = fragments.get(selection.name.value);
        if (fragment) {
          cost += costOfSelectionSet(fragment.selectionSet, fragments, fieldCosts, inMutationRoot, depth + 1);
        }
        break;
      }
    }
  }
  return cost;
}

/**
 * Estimated execution cost of the whole document. Reflects the resolver-call multiplication caused by aliases and fragment spreads.
 */
export function calculateOperationCost(document: DocumentNode, options: QueryCostOptions = {}): number {
  const fieldCosts = options.fieldCosts ?? FIELD_COSTS;

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') {
      fragments.set(definition.name.value, definition);
    }
  }

  let cost = 0;
  for (const definition of document.definitions) {
    if (definition.kind === 'OperationDefinition') {
      const inMutationRoot = definition.operation === 'mutation';
      cost += costOfSelectionSet(definition.selectionSet, fragments, fieldCosts, inMutationRoot, 0);
    }
  }
  return cost;
}

/**
 * envelop plugin: computes the cost right after parse and rejects queries over the limit before
 * validation/execution.
 */
export function useQueryCostAnalysis(options: QueryCostOptions = {}): Plugin {
  const maximumCost = options.maximumCost ?? readMaximumCostFromEnv() ?? DEFAULT_QUERY_COST_LIMIT;
  const fieldCosts = options.fieldCosts ?? FIELD_COSTS;

  return {
    // Validate, not parse. A parse-phase replacement is treated as an internal
    // failure by graphql-yoga and masked into a 500 — the `http: { status: 400 }`
    // extension never reaches the response. Validation errors are client errors
    // by definition, so the same GraphQLError arrives as the 400 it declares.
    // Measured: parse phase returned 500 while logging `http: { status: 400 }`.
    onValidate({ params, setResult }) {
      const cost = calculateOperationCost(params.documentAST, { fieldCosts });
      if (cost <= maximumCost) return;
      setResult([
        new GraphQLError(
          `Query cost ${cost} exceeds the maximum allowed cost of ${maximumCost}.`,
          {
            extensions: {
              code: 'GRAPHQL_COST_LIMIT_EXCEEDED',
              cost,
              maximumCost,
              http: { status: 400 },
            },
          },
        ),
      ]);
    },
  };
}
