# SCADify — design brief

A tiny Node package that turns deterministic 3D-model recipes into clean meshes.
A recipe is a few hundred bytes of JSON (plain OpenSCAD inside, or a boolean
tree); the engine compiles it on demand and exports the result. Target install
footprint is ~7.5 MB (one heavy WASM dependency).

## Design principles (non-negotiable)

1. **Recipe is the source.** A recipe is a small JSON file (default store:
   `store/`, one per ref). Deterministic: same recipe + params + seed ⇒ same
   geometry, byte-for-byte on the same platform. Rendering is a disposable
   derived output — never store the mesh.
2. **One heavy dependency:** `openscad-wasm-prebuilt` (in-process OpenSCAD with
   the Manifold backend = exact booleans, deterministic mesh). Everything else
   is Node stdlib. No SQLite, no sharp, no puppeteer, no Next.js, no audio, no
   browser, no ffmpeg, no engines.
3. **Clean glTF / GLB.** The mesh only. No ground plane, no default camera
   cluster, no light rig, no deep transform hierarchy. Flat tree: one node per
   named part, mesh prim under it, PBR baseColor from the part's tint. Units are per recipe (mm|cm|dm|m, default dm); GLB/USD are exported in metres (scale 1),
   z-up; glTF has no ratified units extension, so that is declared in
   `asset.extras` (`units`, `metersPerUnit`, `upAxis`). Cameras/lights only
   appear if a caller explicitly asks.
4. **USDZ / USDA output** — the editing/postprocess path (glTF is for engine
   consumption). Also emit STL + 3MF (print) and SCAD (the program itself /
   transpiled).
5. **The whole surface area**: a pattern for generating 3D models, a single
   endpoint to add-and-compile, and an MCP to render from angles and export.
   Nothing more.

## Recipe model

```jsonc
{
  "kind": "scad",            // "scad" (program is the source) | "csg"
  "title": "demo-tray",
  "units": "dm",
  "seed": 7,
  "program": "module tray(){ ... }",   // for kind:"scad", stored verbatim
  "parts": { "tray": "tray();", "standoffs": "standoffs();" },
  "params": { "wall_h": 12 }           // editable; compile is a function of these
}
```

For `kind:"csg"`, the recipe describes a boolean tree of primitives
(cube/cylinder/sphere/translate/rotate/union/difference/hull) which is compiled
via the Manifold backend and can also be transpiled to `.scad`. A part statement
may omit its trailing `;` — the engine terminates it (OpenSCAD's `-D` only
overrides variables the program declares; the engine pre-declares seed + params,
so `-D` stays the override).

## MCP surface (stdio, hand-rolled JSON-RPC — no SDK dep)

- `mint_solid` — store a recipe → `{ ref }`.
- `list_solids` / `get_solid` — list refs / return the recipe.
- `update_solid` — edit params/program/parts/tree/title/seed/tints in place.
- `export_solid` — the single add-and-compile endpoint: given `ref` and `format`
  (`glb|gltf|stl|3mf|usdz|usda|scad|json`), compile deterministically and write
  the file → `{ path, format, sizeBytes, sha256, ref }`.
- `render_turntable` — N PNG frames (3–36 angles) of the compiled solid, in-Node.
- `render_shot` — exactly one PNG at a chosen azimuth/elevation (`angle_deg` 0 =
  the model front, `-y` face); `background` arg for a solid color or transparent.
- `render_standard` — one opaque composite: front-on + angled-high shots
  side-by-side on a dark studio background.
- `measure_solid` — bounding box + volume + mesh checksum (determinism gate).

## Software rasterizer (in-Node, no canvas, no lib)

`src/raster.js` projects triangle soup from any camera angle, z-buffers, and
flat-shades by the triangle normal against a key light. Supports an opaque
studio background (default `#0C1019`) or a transparent alpha channel, and writes
PNGs with a hand-rolled encoder (node:zlib + packed chunks). Good enough for
previews; not a renderer.

## Layout

```
scadify/
  package.json          # name "scadify", bin "scadify"
  .claude-plugin/plugin.json  # Claude plugin manifest (mcpServers -> node ${CLAUDE_PLUGIN_ROOT}/src/scadify-cli.mjs)
  src/
    scadify-cli.mjs     # stdio MCP server entry + one-shot CLI (package bin)
    recipe.js           # parse/validate/normalize recipes
    store.js            # plain JSON fs store (CRUD, no DB)
    engine.js           # openscad-wasm-prebuilt wrapper: compile recipe -> mesh
    emitters/           # glb.js, stl.js, 3mf.js, usd.js, scad.js, zip.js
    raster.js           # software rasterizer + PNG encoder (turntable/shot/standard)
    mcp.js              # stdio JSON-RPC MCP server + tool defs
  examples/             # canonical showcase recipes (JSON, no builder)
  docs/previews/        # rendered side-by-side showcase images
  tests/                # node:test suite
```

## Hard rules

- Self-contained: import no external code; the showcase examples are the
  reference for every pattern.
- Every emitter produces a mesh-only, clean hierarchy (rule 3). USD/USDZ and
  the zip stay dependency-free (no external USD lib).
- `export_solid` is byte-for-byte deterministic for a fixed recipe on one
  platform (V8 Math caveats allowed).
- Tests: at least one round-trip per format and one determinism check (two
  compiles → same checksum); `npm` lockfile committed; only runtime dependency
  is `openscad-wasm-prebuilt`.

## Definition of done

`npm test` passes; `node src/scadify-cli.mjs` starts and answers `initialize`; README.md
documents the recipe pattern, the tools, and an end-to-end example (mint a
showcase recipe, export glb/stl/usdz, render a standard preview) with the actual
commands.
