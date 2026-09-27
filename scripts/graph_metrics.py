"""Static graph metrics for the New Eden stargate network.

These are properties of the topology itself, so they are computed once at build
time and stored alongside it rather than recomputed in the browser. Betweenness
in particular is far too expensive to run interactively.

Everything here works on a compact integer indexing of the graph, which keeps
the inner loops out of dictionaries. Traversals are iterative: the stargate
graph has long chains, and a recursive depth-first search risks exhausting the
interpreter's stack.

Definitions used:

- degree              number of stargate links.
- articulation point  a system whose removal disconnects systems that could
                      otherwise still reach each other.
- bridge              a stargate link whose removal does the same.
- betweenness         the share of all shortest paths between all other pairs
                      of systems that pass through this one. Computed with
                      Brandes' algorithm.
- component           the connected piece of the gate network a system sits in.

A system with no stargates has no meaningful value for any of these, and is
reported with zeros and its own singleton component.
"""

from __future__ import annotations

from collections import deque


class Graph:
    """An undirected graph over a compact 0..n-1 index."""

    def __init__(self, ids, neighbors_of):
        self.ids = list(ids)
        self.index = {node_id: i for i, node_id in enumerate(self.ids)}
        self.adjacency = []
        for node_id in self.ids:
            row = [self.index[n] for n in neighbors_of(node_id) if n in self.index]
            self.adjacency.append(row)

    def __len__(self):
        return len(self.ids)


def degrees(graph):
    return [len(row) for row in graph.adjacency]


def components(graph):
    """Return (component_id_per_node, sizes_by_component_id)."""
    n = len(graph)
    component = [-1] * n
    sizes = []
    for start in range(n):
        if component[start] != -1:
            continue
        cid = len(sizes)
        size = 0
        stack = [start]
        component[start] = cid
        while stack:
            v = stack.pop()
            size += 1
            for w in graph.adjacency[v]:
                if component[w] == -1:
                    component[w] = cid
                    stack.append(w)
        sizes.append(size)
    return component, sizes


def articulation_points_and_bridges(graph):
    """Iterative Tarjan. Returns (set of articulation indices, set of bridge
    index pairs as sorted tuples)."""
    n = len(graph)
    adjacency = graph.adjacency
    discovery = [-1] * n
    low = [0] * n
    parent = [-1] * n
    articulation = set()
    bridges = set()
    timer = 0

    for root in range(n):
        if discovery[root] != -1:
            continue

        root_children = 0
        # Each frame carries its own position in the neighbour list, so the
        # walk resumes where it left off instead of restarting.
        # The third slot records whether the edge back to the parent has been
        # skipped once. Skipping EVERY edge to the parent is wrong when two
        # nodes are joined twice: the pair would be reported as a bridge when
        # neither edge can disconnect anything. The shipped graph has no such
        # pair, but the algorithm should be right regardless.
        stack = [[root, iter(adjacency[root]), False]]
        discovery[root] = low[root] = timer
        timer += 1

        while stack:
            frame = stack[-1]
            v, iterator = frame[0], frame[1]
            advanced = False
            for w in iterator:
                if discovery[w] == -1:
                    parent[w] = v
                    discovery[w] = low[w] = timer
                    timer += 1
                    if v == root:
                        root_children += 1
                    stack.append([w, iter(adjacency[w]), False])
                    advanced = True
                    break
                if w == parent[v] and not frame[2]:
                    frame[2] = True
                    continue
                if discovery[w] < low[v]:
                    low[v] = discovery[w]
            if advanced:
                continue

            stack.pop()
            if stack:
                u = stack[-1][0]
                if low[v] < low[u]:
                    low[u] = low[v]
                if low[v] > discovery[u]:
                    bridges.add((u, v) if u < v else (v, u))
                if u != root and low[v] >= discovery[u]:
                    articulation.add(u)

        if root_children > 1:
            articulation.add(root)

    return articulation, bridges


def betweenness(graph, progress=None):
    """Brandes' algorithm for unweighted undirected graphs.

    Returns raw pair-counted scores, halved for the undirected double count.
    """
    n = len(graph)
    adjacency = graph.adjacency
    score = [0.0] * n

    for source in range(n):
        if progress is not None and source % 500 == 0:
            progress(source, n)

        stack = []
        predecessors = [[] for _ in range(n)]
        sigma = [0.0] * n
        distance = [-1] * n
        sigma[source] = 1.0
        distance[source] = 0
        queue = deque([source])

        while queue:
            v = queue.popleft()
            stack.append(v)
            dv = distance[v]
            sv = sigma[v]
            for w in adjacency[v]:
                if distance[w] < 0:
                    distance[w] = dv + 1
                    queue.append(w)
                if distance[w] == dv + 1:
                    sigma[w] += sv
                    predecessors[w].append(v)

        delta = [0.0] * n
        while stack:
            w = stack.pop()
            coefficient = (1.0 + delta[w]) / sigma[w]
            for v in predecessors[w]:
                delta[v] += sigma[v] * coefficient
            if w != source:
                score[w] += delta[w]

    return [value / 2.0 for value in score]


def compute(systems):
    """Compute every metric for a mapping of system_id -> system record.

    Only systems with at least one stargate enter the graph. The rest are
    reported with zeros, because "no route passes through here" is true of a
    system no route can reach.
    """
    gated = [sid for sid, s in systems.items() if s["neighbors"]]
    graph = Graph(gated, lambda sid: systems[sid]["neighbors"])

    degree = degrees(graph)
    component, sizes = components(graph)
    articulation, bridges = articulation_points_and_bridges(graph)
    scores = betweenness(graph)

    largest = max(sizes) if sizes else 0
    metrics = {}
    for sid, s in systems.items():
        metrics[sid] = {
            "degree": 0,
            "betweenness": 0.0,
            "articulation": False,
            "component": -1,
            "component_size": 0,
        }
    for i, sid in enumerate(graph.ids):
        cid = component[i]
        metrics[sid] = {
            "degree": degree[i],
            "betweenness": round(scores[i], 3),
            "articulation": i in articulation,
            "component": cid,
            "component_size": sizes[cid],
        }

    bridge_pairs = {
        tuple(sorted((graph.ids[a], graph.ids[b])))
        for a, b in bridges
    }

    return {
        "metrics": metrics,
        "bridges": bridge_pairs,
        "component_sizes": sorted(sizes, reverse=True),
        "largest_component": largest,
    }
