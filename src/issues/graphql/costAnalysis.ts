// ============================================
// OpenSwarm - GraphQL Query Cost Analysis
// Created: 2026-04-14
// Purpose: alias/fragment-spread로 곱해지는 리졸버 실행을 비용에 반영하고 한도 초과 쿼리를 실행 전에 거부
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
 * 실행 비용이 큰 레지스트리/이슈 뮤테이션의 대표 비용 (cost units).
 * bulkRegisterEntities는 최대 100개 엔티티를 쓰기 때문에 단일 필드 비용을 500으로 부과한다.
 * autoLinkMemories는 임베딩 검색 + 다중 링크를 수행하므로 동일 예산에 둔다.
 */
export const BULK_REGISTER_ENTITIES_COST = 500;
export const AUTO_LINK_MEMORIES_COST = 500;

/**
 * 뮤테이션 루트 최상위 필드의 실행 대표 비용 매핑.
 * (DoD 명칭: FIELD_COSTS — 뮤테이션/쿼리 루트 필드 비용 테이블)
 */
export const FIELD_COSTS: Record<string, number> = {
  bulkRegisterEntities: BULK_REGISTER_ENTITIES_COST,
  autoLinkMemories: AUTO_LINK_MEMORIES_COST,
};

/** 기본 쿼리 비용 상한 */
export const DEFAULT_QUERY_COST_LIMIT = 500;

/** 파편 순환/과도 중첩 확산에 대한 재귀 깊이 상한 (스택 폭주 방지) */
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
 * 필드 1개의 기본 비용. 뮤테이션 루트의 최상위 필드 중 등록된 비싼 뮤테이션은
 * 실행 대표 비용으로 대체한다. alias는 별개 Field 노드이므로 각각 비용이 부과된다.
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
 * selection set의 총비용. FragmentSpread/InlineFragment는 사용 지점에서 확산한다 —
 * 같은 파편을 N번 spread하면 그 안의 리졸버가 N번 실행되므로 비용도 N배로 곱해진다.
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
        // 비싼 뮤테이션의 하위 selectionSet({ id } 등)은 대표 비용에 포함 — 별도 가산 안 함
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
 * 문서 전체의 예상 실행 비용. alias와 fragment spread로 인한 리졸버 호출 곱셈을 반영한다.
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
    onParse() {
      return ({ result, replaceParseResult }) => {
        if (!result || result instanceof Error) return;
        const cost = calculateOperationCost(result, { fieldCosts });
        if (cost > maximumCost) {
          replaceParseResult(
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
          );
        }
      };
    },
  };
}
