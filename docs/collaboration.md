# Single-driver collaboration

Open any notebooks from browser pages connected to the **same gateway workspace**.
The first page to join is Driver for the entire workspace; subsequent pages are
read-only Observers, even if they start on different notebooks. Each page shares
one private identity across its notebook subscriptions. Separate gateways remain
separate workspaces.
Selection, scrolling and cell/output collapse remain local view preferences.
Saved edits, structural changes and execution output reach all joined pages.
Unsaved keystrokes are not broadcast: normal autosave commits them first.

## Replaceable policy and handoff

`services/gateway/app/collaboration.py` owns notebook membership, ownership and
latest-snapshot fanout without HTTP dependencies. `Collaboration(elect=...)`
accepts a synchronous election function over connection-ordered public client
IDs. The default `first_connected` elects the oldest remaining connection.
`change_driver(notebook_path, client_id)` is the policy-neutral handoff function;
its caller must authorize the request. Handoffs are refused during accepted
mutating commands, including execution. The HTTP adapter permits only the
current driver to call it. A future operator policy can call the same function.

Transport-neutral frontend workspace tools expose:

```json
{"tool":"get_collaboration","arguments":{"notebook_path":"lesson.ipynb"}}
{"tool":"change_workspace_driver","arguments":{"notebook_path":"lesson.ipynb","client_id":"<connected public client ID>"}}
```

The addressed notebook must be open, but handoff transfers all notebooks at once,
including notebooks only open in the target page. `change_notebook_driver` remains
a compatibility alias with the same workspace-wide semantics. Handoff refuses
unsaved edits in any open frontend notebook and accepted commands in any room.
Browser clients are connections,
not authenticated people: another tab is another collaborator. There is no
remote user identity system or permission to seize control as an observer.

## HTTP adapter

All calls are same-origin and scoped with `x-notebook-path` (URI-encoded relative
path). `POST /api/v1/collaboration/join` returns a public role/client list and a
private random capability. Subsequent calls carry it in `x-notebook-client`.
The capability stays in browser memory, never storage, URLs or WebMCP results.
To subscribe to another notebook as the same workspace client, send the existing
capability to `join`. Invalid capabilities fail closed; frontend reconnect creates
a new identity only after an expired-session rejection. Joins are serialized.

- `GET /api/v1/collaboration/events?after=<sequence>` waits for a new snapshot or
  membership event, with a 10-second heartbeat. It returns immediately when
  changes arrive; this is HTTP long-poll fanout, not periodic notebook querying.
- `POST /api/v1/collaboration/driver/<public-client-id>` transfers workspace control.
- `POST /api/v1/collaboration/leave` releases one notebook subscription; leaving
  the last subscription releases workspace membership.
- Existing commands and execution NDJSON routes are unchanged except for the
  required capability on writes. Missing/observer credentials return `not_driver`,
  before cache lookup or Jupyter operations. Human and WebMCP mutations remain on
  the same validated command path.

Observers receive bounded full snapshots, validated by WASM before egui applies
them. Slow consumers may skip intermediate frames but receive the latest state:
clears and display replacements cannot resurrect earlier output. Per-notebook
command admission prevents competing mutations racing the revision check.
Interrupt remains available out of band to the driver. Accepted executions
continue broadcasting after the requesting browser disconnects.

Connections expire after 45 seconds without a heartbeat; the next membership
check elects the oldest survivor. Ownership never expires during accepted work.
Explicit close releases promptly; browsers which cannot send unload requests
use the lease. Brief interruptions fail the UI closed while reconnecting.

## Opt-in follow mode

Observers can enable **Follow driver** in the header. It is off by default and
drivers see an orange **Driver** status badge instead of the follow button. Roles
are workspace-wide and the header updates when handing
off control. Follow mode
resets on reload. **Stop following** immediately releases scroll control and
cancels pending automatic notebook selection. The notebook where follow was
enabled supplies its subscription; keep it open in the follower workspace.
The driver need not have that notebook open. Presence is workspace-wide, so a
follower starting on another notebook still receives the driver's current view.

Follow uses a bounded `FollowView` (`protocol_version: 1`, `notebook_path`,
`scroll_fraction` in `[0,1]`, optional `selected_cell_id`, public `driver_id`).
Followers mirror the driver's selected-cell highlight using the stable cell ID;
unknown/deleted IDs are ignored and no editor focus or editing rights are granted.
Selection-only changes are streamed even when the viewport stays still.
Fractions are relative to the
scrollable document length, not browser pixels. Collapsed cells and different
layout widths can therefore produce approximate rather than pixel-identical
reading positions. Output collapse and notebook edits are not changed
by follow. Unsaved work or becoming driver prevents automatic navigation.

`web/src/follow.ts` is the transport-independent opt-in/cancellation controller;
its `FollowTransport.subscribe` and `FollowPublisher.publish` interfaces also
support in-memory transports for tests. `NotebookCollaboration` supplies the
current HTTP adapter. Publishing is
through `Collaboration.publish_view` with authorization for both the anchor and
target notebook. No public client ID can substitute for a connection capability.

`POST/GET /api/v1/collaboration/view` carries presence separately from document
snapshots. Small long-poll events coalesce to the latest view; scrolling never
increments notebook revisions or resends cell contents. Browser publishing is
throttled to four times per second and unchanged positions are deduplicated.
Only opted-in observers subscribe to this presence stream. Disconnects and
driver changes pause follow and release pinned scrolling; promotion to driver
turns follow off. Nothing is written into the notebook file.

WASM exposes `scrollFraction()` and bounded `setFollowScroll(fraction|null)` on
the mounted notebook. egui owns the scroll area; TypeScript owns transport and
workspace selection. `get_active_context` also reports `scroll_fraction`.

## Limits and trust

This coordinates **one gateway process**, not independent replicas or JupyterLab
clients. Do not use multiple Uvicorn workers without replacing the coordinator
with shared atomic ownership and pub/sub. Kernel code can still edit filesystem
data directly; this is not a security sandbox. Keep deployment loopback-only and
trusted. A malicious local process can join; this is not remote authentication.
Driver control governs submitted notebook commands, not what arbitrary executed
code can do. Kernel/Jupyter credentials still remain entirely server-side.

Limits: 32 clients per workspace and 256 notebook rooms per gateway lifetime.
One latest snapshot per room bounds slow-reader buffering. Restarting the gateway
resets leases and revision bookkeeping; reload browser pages after a gateway
restart. Renaming requires a sole connected driver; its event subscription follows
the new identity, but commands sent to the old path are rejected. Notebook contents
remain accessible through the confined Contents service.

## Verification

`services/gateway/tests/test_collaboration.py` covers election replacement,
handoff, lease expiry, notebook isolation, output replacement fanout and HTTP
write rejection. `tests/browser/collaboration.spec.ts` covers two real browser
clients, WebMCP edit rejection, intermediate kernel output, handoff and departure.
Run `scripts/check.sh` and `scripts/container-check.sh` (after building the image).
