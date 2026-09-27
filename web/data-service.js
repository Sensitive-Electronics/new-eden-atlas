// The only thing that fetches the archive. Every path to the data goes through
// here, so one place knows where it lives and how it is cached.

const DATA_ROOT = "../data";
const regionCache = new Map();
let activeRegionRequest = null;

// The archive is revalidated rather than versioned by hand.
//
// `cache: "no-cache"` asks the browser to revalidate rather than to re-download:
// it sends the conditional request and takes a 304 when the file has not moved,
// which costs a round trip on a local server and can never serve a stale
// archive. Nothing has to remember to bump a version string.
async function fetchJson(path, signal) {
  const response = await fetch(path, { signal, cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Archive request failed (${response.status}): ${path}`);
  }
  return response.json();
}

function regionFile(name) {
  return `${name.replaceAll(" ", "_").replaceAll("/", "_")}.json`;
}

export async function loadAtlas() {
  const [index, atlas] = await Promise.all([
    fetchJson(`${DATA_ROOT}/regions.json`),
    fetchJson(`${DATA_ROOT}/eve_map_all.json`),
  ]);
  return { index, atlas };
}

export async function loadShips() {
  return fetchJson(`${DATA_ROOT}/ships.json`);
}

export async function loadRegionData(name) {
  activeRegionRequest?.abort();
  activeRegionRequest = null;
  if (regionCache.has(name)) return regionCache.get(name);

  const controller = new AbortController();
  activeRegionRequest = controller;

  try {
    const data = await fetchJson(`${DATA_ROOT}/regions/${regionFile(name)}`, controller.signal);
    regionCache.set(name, data);
    return data;
  } finally {
    if (activeRegionRequest === controller) activeRegionRequest = null;
  }
}
