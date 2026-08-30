# Local Asset Warehouse

The warehouse gives isolated workers one stable, Git-external place to find
credentials, customer-provided files, cross-repository evaluation artifacts,
and operating recipes. It is intended for a single-operator deployment where
all workers may inspect the same material.

## Host layout

The default Compose path is `../openswarm-warehouse` relative to the Compose
file. Override it with `OPENSWARM_WAREHOUSE_HOST`.

```text
openswarm-warehouse/
  INDEX.md
  cgf-portal/
    data/
    env/
    nas.md
  vega-agent/
    env/
    artifacts/
  vega-router/
    env/
    artifacts/
  vega-plugins/
    env/
    artifacts/
  shared/
    fixtures/
```

`INDEX.md` is the front door. List paths, intended consumers, freshness, key
names, and usage commands there. Never copy credential values into the index,
logs, issue comments, or agent answers.

## Mount and permission model

Compose mounts the same host directory twice:

- `/warehouse` is read-only and is the only path advertised to agents.
- `/warehouse-rw` is used by the authorized web upload handler.

The in-process `read_file` and `search_files` tools may read `/warehouse`, while
all edit tools reject it. The mount enforces the same rule for ordinary writes
to `/warehouse`. Because daemon and workers currently share one container user,
a worker shell could discover `/warehouse-rw`; this deployment model is not a
multi-tenant security boundary. Split the web service and worker uid before
using the warehouse with mutually distrusting workers.

## Web file manager

Open `http://<host>:3847/warehouse`. The page can:

- browse names, sizes, and modification times;
- browse directories capped at 200 entries (split larger sets into subdirectories);
- download a file, streamed by the server and capped at 250 MiB;
- upload into the current directory, capped at 50 MiB;
- overwrite only when the operator explicitly enables it.

When `OPENSWARM_WEB_TOKEN` protects a remote deployment, enter that value in
the page's **OpenSwarm web token** field. It is sent only as the
`X-OpenSwarm-Token` request header and retained in `sessionStorage`, so closing
the browser tab clears it. Downloads also use authenticated `fetch`; the token
is never placed in a URL.

There is deliberately no delete endpoint. API routes inherit the dashboard's
loopback/Tailscale/token authorization and reject absolute paths, traversal,
and symlinks that leave the configured root.

## Container configuration

```env
OPENSWARM_WAREHOUSE_HOST=/srv/openswarm-warehouse
OPENSWARM_MEMORY_LIMIT=48g
```

Inside the container the roots are fixed by Compose:

```env
OPENSWARM_WAREHOUSE_ROOT=/warehouse
OPENSWARM_WAREHOUSE_WRITE_ROOT=/warehouse-rw
```

After provisioning, verify both interfaces independently: use an agent
`read_file` call against `/warehouse/INDEX.md`, then browse/download/upload from
the live `/warehouse` page. A successful shell `cat` alone does not prove the
file-tool sandbox is wired correctly.
