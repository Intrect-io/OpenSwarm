import { createServer } from 'node:http';
import { handleGraphQL } from './src/issues/graphql/server.js';

async function main() {
  process.env.OPENSWARM_GRAPHQL_TOKEN = 'test-token';
  const httpServer = createServer(async (req, res) => {
    if (req.url?.startsWith('/graphql')) {
      await handleGraphQL(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
    httpServer.on('error', reject);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({
      query: `
        mutation {
          a: bulkRegisterEntities(input: [{ qualifiedName: "w", kind: CLASS }]) { id }
          b: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
          c: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
          d: bulkRegisterEntities(input: [{ qualifiedName: "z", kind: CLASS }]) { id }
        }
      `,
    }),
  });
  console.log('status:', response.status);
  const body = await response.json();
  console.log('body:', JSON.stringify(body, null, 2));
  httpServer.close();
}
main().catch(console.error);
