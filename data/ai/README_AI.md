# AI Use Notes

This folder is for local agents and scripts. It contains compact topology exports generated from the official CCP EVE Static Data Export.

Use this when you need:

- region/system lookup
- stargate adjacency
- route graph input
- region-boundary pipes
- local offline analysis without DOTLAN scraping

Recommended files:

- `systems.jsonl`: best general-purpose system lookup. Includes names, IDs, security, coordinates, and neighbor names.
  Two coordinate systems: `x`/`y`/`z` are physical, in meters, and are what every distance and jump-range figure uses.
  `x2d`/`y2d` are CCP's official map layout, for display only, and are null for the 3,005 systems with no published
  layout - 2,604 in J-space, 200 in the Abyssal proving grounds, and 201 in CCP's VR-* and GPMR-01 test regions, none of which carry a stargate. Every system reachable by gate has one. Null means no layout, not the origin. Draw with `screenY = -y2d`.
- `jumps.jsonl`: best for graph/pathfinding. One undirected stargate edge per row.
- `cross_region_jumps.jsonl`: best for choke/pipe analysis.
- `chokepoints.jsonl`: articulation points and low-degree systems, ranked by betweenness.
- `bridges.jsonl`: stargate links whose loss would split the network.
- `regions.jsonl`: best for enumerating regions.
- `../eve_map.sqlite`: best for SQL queries.

Example SQLite queries:

```sql
-- Find all systems in a region
select name, security from systems
where region_id = (select region_id from regions where name = 'Catch')
order by name;

-- Find cross-region jumps touching Catch
select fs.name as from_system, fr.name as from_region, ts.name as to_system, tr.name as to_region
from jumps j
join systems fs on fs.system_id = j.from_system_id
join systems ts on ts.system_id = j.to_system_id
join regions fr on fr.region_id = fs.region_id
join regions tr on tr.region_id = ts.region_id
where fr.name = 'Catch' or tr.name = 'Catch'
order by from_region, from_system;
```

Important: this is static topology. It does not include live sovereignty, kills, jumps, player structures, ansiblexes, or current control.
