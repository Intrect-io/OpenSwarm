#!/usr/bin/env node
/**
 * Minimal smoke test for GraphQL cost analysis without vitest.
 * Mirrors the costing assertions in src/issues/graphql/server.test.ts.
 */
import { parse } from 'graphql';
import {
  calculateOperationCost,
  BULK_REGISTER_ENTITIES_COST,
  DEFAULT_QUERY_COST_LIMIT,
  useQueryCostAnalysis,
} from '../src/issues/graphql/costAnalysis.ts';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const simple = calculateOperationCost(parse('{ __typename }'));
assert(simple === 1, `expected 1, got ${simple}`);

const single = calculateOperationCost(parse(`
  mutation {
    bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
  }
`));
assert(single === BULK_REGISTER_ENTITIES_COST, `single cost ${single}`);

const aliased = calculateOperationCost(parse(`
  mutation {
    a: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
    b: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
  }
`));
assert(aliased === BULK_REGISTER_ENTITIES_COST * 2, `aliased cost ${aliased}`);

const fragments = calculateOperationCost(parse(`
  mutation {
    ...BulkRegistration
    ...BulkRegistration
  }
  fragment BulkRegistration on Mutation {
    bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
  }
`));
assert(fragments === BULK_REGISTER_ENTITIES_COST * 2, `fragment cost ${fragments}`);
assert(fragments > DEFAULT_QUERY_COST_LIMIT, 'fragments should exceed default limit');

const four = calculateOperationCost(parse(`
  mutation {
    a: bulkRegisterEntities(input: [{ qualifiedName: "w", kind: CLASS }]) { id }
    b: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
    c: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
    d: bulkRegisterEntities(input: [{ qualifiedName: "z", kind: CLASS }]) { id }
  }
`));
assert(four === BULK_REGISTER_ENTITIES_COST * 4, `four-alias cost ${four}`);
assert(four > DEFAULT_QUERY_COST_LIMIT, 'four aliases should exceed default limit');

assert(typeof useQueryCostAnalysis === 'function', 'useQueryCostAnalysis export');

console.log(JSON.stringify({
  ok: true,
  BULK_REGISTER_ENTITIES_COST,
  DEFAULT_QUERY_COST_LIMIT,
  costs: { simple, single, aliased, fragments, four },
}));
