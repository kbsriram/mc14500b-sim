// Hand-set symbol data, read by site/symbols.js. The object after '=' is plain JSON.
//   cells   {cell type: {pin role: [label, mark?]}}: pin labels of a cell type drawn as a box or gate;
//           mark is clock (a wedge inside), nclock (a wedge and a bubble: the falling edge) or bubble (active low)
//   shapes  {name: {outline, edges}}: a block's outline and pin edges (in, out, ctl) as [x0, y0, x1, y1] segments,
//           in fractions of the block's width and height
//   blocks  {block: {shape, title, sub?, qualifier?}}: titles from docs/MC14500B_Rev3.pdf p.1's block diagram;
//           qualifier is IEEE Std 91's mark for the block's function
(globalThis.SYMBOLS ??= {}).data = {
  "cells": {
    "dff":         {"in2": ["D"], "in0": ["C", "nclock"], "in3": ["C̄"], "in1": ["R", "bubble"], "out0": ["Q"]},
    "dff_noreset": {"in2": ["D"], "in0": ["C", "nclock"], "in1": ["C̄"], "out0": ["Q"]},
    "dff_en_sr":   {"in1": ["D"], "in0": ["C", "nclock"], "in2": ["C̄"], "in3": ["S"], "in4": ["R"], "out0": ["Q"]},
    "mux2":        {"in1": ["0"], "in2": ["1"], "in0": ["S"]},
    "tristate_out": {"in1": ["EN"]}
  },
  "shapes": {
    "box": {"outline": [[0, 0], [1, 0], [1, 1], [0, 1]],
            "edges": {"in": [[0, 0, 0, 1]], "out": [[1, 0, 1, 1]], "ctl": [[0, 1, 1, 1]]}},
    "mux": {"outline": [[0, 0], [1, 0.2], [1, 0.8], [0, 1]],
            "edges": {"in": [[0, 0, 0, 1]], "out": [[1, 0.2, 1, 0.8]], "ctl": [[0, 1, 1, 0.8]]}},
    "alu": {"outline": [[0, 0], [1, 0.25], [1, 0.75], [0, 1], [0, 0.6], [0.15, 0.5], [0, 0.4]],
            "edges": {"in": [[0, 0, 0, 0.4], [0, 0.6, 0, 1]], "out": [[1, 0.25, 1, 0.75]], "ctl": [[0, 1, 1, 0.75]]}}
  },
  "blocks": {
    "OSC":   {"shape": "box", "title": "OSC", "sub": "clock oscillator", "qualifier": "astable"},
    "RST":   {"shape": "box", "title": "RST", "sub": "reset input", "qualifier": "schmitt"},
    "CLK":   {"shape": "box", "title": "CLK", "sub": "clock gating"},
    "INST":  {"shape": "box", "title": "INSTRUCTION", "sub": "register I0–I3"},
    "CTRL":  {"shape": "box", "title": "CONTROL", "sub": "instruction decoder", "qualifier": "X/Y"},
    "LU":    {"shape": "alu", "title": "LU", "sub": "logic unit"},
    "MUX":   {"shape": "mux", "title": "MUX"},
    "RR":    {"shape": "box", "title": "RR", "sub": "result register"},
    "IEN":   {"shape": "box", "title": "IEN", "sub": "input enable"},
    "OEN":   {"shape": "box", "title": "OEN", "sub": "output enable"},
    "DATA":  {"shape": "box", "title": "DATA", "sub": "data pad"},
    "WRITE": {"shape": "box", "title": "WRITE", "sub": "write pulse"},
    "FLAG":  {"shape": "box", "title": "FLAGS", "sub": "JMP RTN O F"},
    "SKIP":  {"shape": "box", "title": "SKIP", "sub": "skip flip-flop"},
    "TIE":   {"shape": "box", "title": "TIE", "sub": "fixed levels"}
  }
};
