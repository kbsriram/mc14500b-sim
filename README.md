# MC14500B

A switch-level simulation of the Motorola MC14500B, a 1-bit industrial control unit, built from polygons traced on a die photo.

- `die.json`: the traced die, and the single source for everything else: polygons by layer, pins, measured or assumed values, cells and blocks.
- `extract/`: Python (shapely, networkx) that turns `die.json` into the netlist the site runs.
  - `python3 extract/check.py`: consistency checks; writes `extract/problems.json`.
  - `python3 extract/build.py`: writes `site/gen/mc14500b.js`.
- `gen/draft.js`: node; draws the schematic layouts from the netlist into `site/gen/layouts/`.
- `site/`: the browser simulator, static files. `site/gen/` is generated and committed, so the site needs no build step.
- `test/`: node checks of the engine, the card's programs and the layouts.
  - `node test/test.js`, `node test/card_test.js`, `node test/layout_test.js`.

To view locally, serve this directory (for example `python3 -m http.server`) and open `/site/`.
