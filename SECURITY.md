# Security policy

## Supported code

This project is pre-1.0. Security fixes target the current `main` branch; older
commits, development branches, and downstream deployments are not maintained as
separate supported releases.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/didaction/didaction-jupyter/security/advisories/new>

Include the affected commit, runtime mode, reproduction steps, impact, and any
suggested mitigation. Avoid including real credentials, private notebook contents,
or sensitive outputs. Please allow maintainers time to investigate before public
disclosure. If private reporting is unavailable, open a public issue containing no
exploit details and ask for a private contact channel.

## Security model

didaction Jupyter is a single-user local development and learning runtime. Notebook
and playground execution is arbitrary code execution, not a sandbox. Server mode
binds to loopback by default, confines workspace paths, and keeps Jupyter credentials
in the gateway. Browser-local kernels run in Workers for lifecycle isolation, not as
a browser security boundary for hostile code.

WebMCP uses the same bounded protocol as the human UI and exposes no generic Jupyter
or MCP forwarding. Its execution tools reject shell and package-install magics.
These controls reduce accidental exposure; they do not make untrusted notebooks or
kernels safe.

Reports are especially useful for path traversal, credential leakage, origin or
session bypass, command-path bypass, unsafe rich-output rendering, worker escape,
denial-of-service bounds, and supply-chain or distribution issues.
