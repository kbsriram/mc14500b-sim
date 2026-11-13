"""The die's polygons for site/die3d.js: each shape's outline rings, its triangles and the simulation key that colours
it, a net index for metal, contacts and doped silicon, a transistor index for a channel piece, -1 for neither.
A channel is drawn as its pieces outside doped polygons, one transistor each (extract/netlist.py's Die.pieces).
Called by extract/build.py, which knows the net and transistor indices.
"""
import shapely

LAYERS = ['resistor', 'nplus', 'pplus', 'channel', 'contact', 'metal']


def polygon(g, layer, key):
    """{l, k, p, r, t} for shapely polygon g: layer index, key, flat x, y list of its rings (outline, then holes),
    the vertex index where each hole starts, and triangles as vertex index triples."""
    rings = [g.exterior] + list(g.interiors)
    pts, starts, at = [], [], {}
    for ring in rings:
        starts.append(len(pts) // 2)
        for x, y in list(ring.coords)[:-1]:
            at.setdefault((x, y), len(pts) // 2)
            pts += [round(x), round(y)]
    tri = []
    for t in shapely.constrained_delaunay_triangles(g).geoms:
        for x, y in list(t.exterior.coords)[:3]:
            if (x, y) not in at:   # not a ring vertex; CDT adds none, but keep the shape whole if it does
                at[(x, y)] = len(pts) // 2
                pts += [round(x), round(y)]
            tri.append(at[(x, y)])
    return {'l': LAYERS.index(layer), 'k': key, 'p': pts, 'r': starts[1:], 't': tri}


def shapes(die, d, net_key, pieces):
    """The drawn shapes of die.json die, in netlist.Die d: net_key(shape id) gives a shape's key; pieces is
    [(shapely polygon, transistor index)] for the channel pieces."""
    out = []
    for i in d.ids:
        layer = d.shapes[i]['layer']
        if layer == 'channel':
            continue
        key = -1 if layer == 'resistor' else net_key(i)
        g = d.geo[i]
        out += [polygon(p, layer, key) for p in getattr(g, 'geoms', [g]) if not p.is_empty]
    for g, t in pieces:
        out += [polygon(p, 'channel', t) for p in getattr(g, 'geoms', [g]) if not p.is_empty]
    return {'w': die['size'][0], 'h': die['size'][1], 'layers': LAYERS, 'shapes': out}
