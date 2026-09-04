# Qrisp browser compatibility investigation

Investigated 2026-09-03 against the Python 3.13 xeus browser environment.

## Conclusion

Adding WASM Numba/llvmlite does **not** make current Qrisp installable. There is no
verified, dependency-complete Qrisp version for our current channels. Keep the
native kernel for the quantum-school notebooks. This is a package-porting issue,
not an egui rendering or xeus command-adapter issue.

Do not ship fake `jax`, `qiskit`, or Numba modules, silently strip requirements,
or advertise `pip --no-deps` installation as Qrisp support.

## Exact candidate and blockers

Qrisp **0.9.7** accepts Python `>=3.11,<3.14`, but requires NumPy `>=2.0,<2.5`,
`jax==0.7.1`, `jaxlib==0.7.1`, Qiskit `>=0.44.0`, SciPy, Numba, Matplotlib,
SymPy, NetworkX, tqdm, dill, and psutil. Its Python version therefore fits;
the original browser bundle's NumPy 2.5.2 does not. Downgrading NumPy alone is
insufficient. [Published release metadata](https://pypi.org/pypi/qrisp/0.9.7/json)

The upstream initialization imports JAX eagerly and calls its configuration API;
JAX is not merely an optional accelerator for this release. Source inspection:
[Qrisp initialization at commit 6f3d632](https://github.com/eclipse-qrisp/Qrisp/blob/6f3d632634b374e4772a267653dc2c6765f5353a/src/qrisp/__init__.py).

`jaxlib==0.7.1` publishes Linux, macOS, and Windows wheels, not an Emscripten
wheel. The official JAX supported-platform instructions likewise do not list a
browser target. This is evidence about published distribution support, not a
claim that a future port is impossible.
[Release artifacts](https://pypi.org/pypi/jaxlib/0.7.1/json),
[JAX installation](https://docs.jax.dev/en/latest/installation.html).

## Reproduced package-index checks

Commands below used micromamba 2.9.0 and the project's selected upstream channels
on the investigation date. They only query/solve; they do not install packages.

```sh
micromamba repoquery search --platform emscripten-wasm32 --override-channels \
  -c https://prefix.dev/emscripten-forge-4x \
  -c https://prefix.dev/conda-forge jaxlib

micromamba repoquery search --platform emscripten-wasm32 --override-channels \
  -c https://prefix.dev/emscripten-forge-4x \
  -c https://prefix.dev/conda-forge qiskit-terra

micromamba create --dry-run -y --prefix /tmp/didaction-qrisp-wasm-probe \
  --platform emscripten-wasm32 --override-channels \
  -c https://prefix.dev/emscripten-forge-4x \
  -c https://prefix.dev/conda-forge 'python=3.13' 'qiskit=0.46.3'
```

Results:

- `jaxlib`: no matching entries.
- `qiskit-terra`: no matching entries.
- Qiskit 0.46.3 solve: failed because required `qiskit-terra==0.46.3` does not
  exist in the selected target channels.

The Qiskit search does list older **noarch metapackages**, including 0.46.3.
That does not establish that their compiled dependency graph is available.
Primary indexes: [emscripten-forge-4x](https://prefix.dev/channels/emscripten-forge-4x),
[conda-forge](https://prefix.dev/channels/conda-forge).

## Older-version fallback

Qrisp **0.5.4** (also 0.4.15) has no declared JAX/jaxlib dependency, but still
requires `qiskit>=0.44.0`, SciPy, Numba, and other packages. Thus this avoids one
blocker, not the whole compatibility problem. Qrisp **0.7.19** already requires
JAX/jaxlib 0.7.1, so that version does not offer the same escape route.
[0.5.4 metadata](https://pypi.org/pypi/qrisp/0.5.4/json),
[0.4.15 metadata](https://pypi.org/pypi/qrisp/0.4.15/json),
[0.7.19 metadata](https://pypi.org/pypi/qrisp/0.7.19/json).

No older release was executed in-browser during this investigation. Removing
or lazily importing unused dependencies would require a deliberate Qrisp fork,
upstream collaboration, and tests; it is not an environment-only solution.
Course API compatibility is also unverified for these older releases.

## Safe next steps

1. Verify real Numba compilation independently in xeus, with the exact WASM builds
   and genuine compiled signatures (not only successful imports).
2. Leave Qrisp absent from the browser bundle until a complete dependency solve
   and real `QuantumVariable`, Hadamard/CX, measurement, and plotting tests pass.
3. For a separate porting effort, investigate making Qrisp's native simulation
   subset independent of JAX and Qiskit through upstream-supported lazy imports,
   or port the required dependencies. Neither has been implemented here.
4. Re-check these package indexes before revisiting; WASM package availability
   changes independently of xeus.
