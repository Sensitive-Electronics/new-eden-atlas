import {
  loadAtlas, loadRegionData, loadShips
} from "./data-service.js";
import {
  DEFAULT_ROUTE_MODE, HEAT_LEVELS, ROUTE_MODES, RoutePlanner, emptyAvoid, emptyBridges, emptyHeat, mergeBridges
} from "./route-planner.js";
import {
  JumpPlanner, METERS_PER_LIGHT_YEAR
} from "./jump-planner.js";
import {
  JUMP_FIELDS, RANGE_FIELDS, ROUTE_FIELDS, THREAT_FIELDS, isStale, keyFor
} from "./result-state.js";
import {
  bridgeRows, bridgeSummaryMarkup, constellationButtons, corridorRows, corridorSummaryMarkup,
  scoutRows, scoutSummaryMarkup, threatRows,
  fuelModuleOptions, ignoreRows, ignoreSummaryMarkup, legendMarkup,
  limitsSummaryMarkup, searchMatches, searchResultsMarkup, shipOptions
} from "./controls.js";
import { STORAGE_KEYS, readJson, readJsonState, readText, writeJson, writeText } from "./settings.js";
import { clampRailWidth, RAIL_DEFAULT } from "./panel-size.js";
import { graphScale } from "./map-utils.js";
import { failure, parseMessage, reply, replyFault, request } from "./contract.js";
import {
  close as closeSighting, createSightings, fromJSON as sightingsFromJSON, historyFile, mergeHistory,
  observe, openObservations, parseHistoryFile, pruneSightings, prunableSightings,
  toJSON as sightingsToJSON
} from "./sightings.js";
import {
  activeOverride, clearOverride, createStore as createOverrides, describeRemaining, edgeKey,
  isBlocked, isDiscouraged,
  fromJSON as overridesFromJSON, listOverrides, pruneOverrides, setOverride,
  toJSON as overridesToJSON
} from "./overrides.js";
import { allianceColour, heldSystems, holderOf, syncSovereignty } from "./sovereignty.js";
import {
  clearSyncFailure, dataAge, describeAge, isDue, markSyncFailed, setContactRoute,
} from "./esi.js";
import { liveTimeText, refreshLiveTimes, sentence } from "./live-time.js";
import { buildSnapshot } from "./snapshot.js";
import { ask, consider } from "./advisor.js";
import {
  cleanQuestion, closeWindow, createWindows, openWindow, TURN_LIMIT, windowOf, windowTemplate,
} from "./ask-window.js";
import { threatClasses, threatEnvelope, threatsTo } from "./threat-range.js";
import {
  describeSignature, openSignatures, resolveHull, routableSignatures, scoutEndpoint, scoutHubs,
  scoutNetwork, syncScout
} from "./eve-scout.js";
import {
  campaignSystems, campaignsIn, describeCampaign, describeTiming, eventLabel,
  liveNow, openCampaigns, syncCampaigns, upcoming
} from "./campaigns.js";
import {
  createActivity, describeHeat, fromJSON as activityFromJSON, heatOf, hottest,
  playerKillsIn, sampleCount, syncActivity, toJSON as activityToJSON, trendOf
} from "./activity.js";
import {
  contestedFrontlines, describeFrontline, describeIncursion, factionName,
  frontlineSystems, incursionSystems, syncFactionWarfare, syncIncursions
} from "./ambient.js";
import {
  IDENTITY_VIEW, laneAttributes, lanePath, markerTransform, pinAttributes, readLane, readPin,
  viewBoxAttribute, viewBoxFor,
  viewTransform, worldToScreen, zoomedView
} from "./camera.js";
import {
  jumpPanel, lightYears as ly, minutes,
  rangePanel, regionPanel, routeConstraintsPanel, routePanel, systemPanel, tacticalPanel
} from "./panels.js";
import {
  corridorFile, mergeCorridors, normalizeCorridor, parseCorridorFile, readCorridors, removeCorridor, sortCorridors, upsertCorridor, writeCorridors
} from "./corridors.js";
import {
  buildOperationalBrief, normalizeTacticalConfig, TacticalAnalyzer, TACTICAL_PRESETS
} from "./tactical-analyzer.js";
import {
  assignCrossingChannels, assignLaneOffsets, SYSTEM_NODE_HEIGHT
} from "./edge-routing.js";
import {
  chooseMarkerLabels, markerScale, resizedCamera
} from "./map-markers.js";
import {
  HIGH_SECURITY, LAYOUT_MODES,
  escapeHtml as esc, formatSecurity as secFormat,
  labelAnchors, labelBox, selectLabels,
  project, projectionOf, regionLayout,
  relaxLabels, relaxSystems,
  screenDeltaToView, screenToView,
  securityClass as secClass, securityColor as secColor, securityName as secName,
  svg as S
} from "./map-utils.js";
const state={
  box:[1200,760],atlas:null,index:[],region:null,mode:"universe",selected:null,constellation:"all",view:{ x:0,y:0,k:1 },drag:null,nodes:[],
  regionRequestId:0,lanes:null,routePlanner:null,route:null,routeIndex:null,positions:null,avoid:null,limits:null,corridors:[],jumpPlanner:null,
  jump:null,jumpIndex:null,range:null,projection:null,tacticalAnalyzer:null,tactical:null,live:null,sovMeta:null,sovHeld:null,syncing:false,
  overrides:null,bridges:null,avoidOn:true,persistFailed:false,persistPending:false,travelCharacter:null,
  threat:null,threatInputs:null,panel:null,ambientMeta:null,ambientSyncing:false,activity:null,
  activityMeta:null,activitySyncing:false,campaignMeta:null,campaignsLive:null,liveSchemaMismatch:null,lastLiveSyncAt:null,scoutMeta:null,
  scoutNet:null,liveSyncing:false,routeAt:null,
  // The brief's snapshot, minted when the brief is rendered and forked by the
  // button. Null until a brief has been taken, and null again if minting threw.
  briefSnapshot:null,askWindows:createWindows(),advisorUp:false,routeInputsUsed:null,scoutFingerprint:null,
  // The read, the brief *content* it answers, and the snapshot render it is
  // currently bound to. `key` is the budget and survives a re-render;
  // `forSnapshot` is the binding and does not.
  panelRead:{key:null,forSnapshot:null,text:null},panelReadPending:null
};
const $=id=>document.getElementById(id),ui={
  map:$("map"),viewport:$("viewport"),loading:$("loading"),regions:$("regions"),
  regionCount:$("regionCount"),search:$("search"),results:$("searchResults"),title:$("title"),
  eyebrow:$("eyebrow"),metrics:$("metrics"),constellations:$("constellations"),
  bridgeSummary:$("bridgeSummary"),bridgeList:$("bridgeList"),bridgeFrom:$("bridgeFrom"),bridgeTo:$("bridgeTo"),bridgeError:$("bridgeError"),
  ignoreSummary:$("ignoreSummary"),ignoreList:$("ignoreList"),avoidToggle:$("avoidToggle"),
  threatStaging:$("threatStaging"),threatError:$("threatError"),threatClasses:$("threatClasses"),
  ambientBar:$("ambientBar"),ambientSync:$("ambientSync"),ambientAge:$("ambientAge"),ambientError:$("ambientError"),
  liveBar:$("liveBar"),liveSync:$("liveSync"),liveError:$("liveError"),persistError:$("persistError"),
  vaultPanel:$("vaultPanel"),vaultSummary:$("vaultSummary"),vaultCount:$("vaultCount"),
  vaultList:$("vaultList"),vaultError:$("vaultError"),vaultAdd:$("vaultAdd"),
  historyPanel:$("historyPanel"),historySummary:$("historySummary"),historyCount:$("historyCount"),
  historyAge:$("historyAge"),clearHistory:$("clearHistory"),
  cancelClearHistory:$("cancelClearHistory"),historyNote:$("historyNote"),
  exportHistory:$("exportHistory"),importHistory:$("importHistory"),
  historyFileInput:$("historyFileInput"),activityBar:$("activityBar"),activityAge:$("activityAge"),
  askLayer:$("askLayer"),
  routeHeat:$("routeHeat"),campaignBar:$("campaignBar"),campaignAge:$("campaignAge"),
  scoutBar:$("scoutBar"),scoutAge:$("scoutAge"),scoutSummary:$("scoutSummary"),scoutList:$("scoutList"),
  scoutEnabled:$("scoutEnabled"),scoutHull:$("scoutHull"),scoutError:$("scoutError"),
  layoutBar:$("layoutBar"),sovBar:$("sovBar"),sovSync:$("sovSync"),sovAge:$("sovAge"),sovError:$("sovError"),layoutAtlas:$("layoutAtlas"),layoutCcp:$("layoutCcp"),
  layoutNote:$("layoutNote"),inspector:$("inspector"),inspectorClose:$("inspectorClose"),
  railResize:$("railResize"),
  empty:$("emptyInspector"),content:$("inspectorContent"),tooltip:$("tooltip"),
  coordinates:$("coordinates"),legend:$("legend"),universeTab:$("universeTab"),
  regionTab:$("regionTab"),rail:$("rail"),toolsToggle:$("toolsToggle"),routeFrom:$("routeFrom"),
  routeTo:$("routeTo"),routeMode:$("routeMode"),routeError:$("routeError"),
  avoidSystems:$("avoidSystems"),avoidRegions:$("avoidRegions"),jumpPanel:$("jumpPanel"),
  jumpShip:$("jumpShip"),jumpFrom:$("jumpFrom"),jumpTo:$("jumpTo"),
  jumpCalibration:$("jumpCalibration"),jumpConservation:$("jumpConservation"),
  jumpHullSkill:$("jumpHullSkill"),jumpFuelModule:$("jumpFuelModule"),
  jumpHullLabel:$("jumpHullLabel"),jumpFuelNote:$("jumpFuelNote"),jumpHighSec:$("jumpHighSec"),
  jumpError:$("jumpError"),rangeRings:$("rangeRings"),corridorPanel:$("corridorPanel"),
  corridorName:$("corridorName"),corridorList:$("corridorList"),
  corridorSummary:$("corridorSummary"),corridorError:$("corridorError"),
  corridorFileInput:$("corridorFile"),limitsPanel:$("limitsPanel"),
  limitsSummary:$("limitsSummary"),routeMinSec:$("routeMinSec"),routeMaxSec:$("routeMaxSec"),
  tacticalSystem:$("tacticalSystem"),tacticalPreset:$("tacticalPreset"),
  tacticalDepth:$("tacticalDepth"),tacticalError:$("tacticalError"),
  panelRead:$("panelRead"),
  tacticalFile:$("tacticalFile"),blockSecurity:$("blockSecurity"),
  blockApproaches:$("blockApproaches"),blockChokes:$("blockChokes"),
  blockBorders:$("blockBorders")
};
function regionType(r){
  if(r.region_id>=11000000&&r.region_id<12000000)return"wormhole";
  if([10000070,10000004,10001000].includes(r.region_id))return"special";
  return r.systems.some(id=>state.atlas.systems[id]?.security>=HIGH_SECURITY)?"empire":"null"
}
function setViewBox(mode){
  state.box = viewBoxFor(mode);
  ui.map.setAttribute("viewBox", viewBoxAttribute(state.box));
}
function resetView(){
  state.view = { ...IDENTITY_VIEW };
  applyView();
}
// The two outlines drawn around a system capsule, expressed as padding rather
// than as finished numbers.
//
// Written out as finished heights - 38 for the halo and 40 for the range outline -
// they are correct only because `SYSTEM_NODE_HEIGHT` happens to be 32. The capsule is
// drawn from that constant, so a change to it would move the node and leave both
// outlines behind.
const HALO_PADDING = 6;
const RANGE_OUTLINE_PADDING = 8;
const HALO_HEIGHT = SYSTEM_NODE_HEIGHT + HALO_PADDING;
const RANGE_OUTLINE_HEIGHT = SYSTEM_NODE_HEIGHT + RANGE_OUTLINE_PADDING;

let previousMarkerLabels = new Set();
let lastLaneInverse = null;
let previousMapRect = null;
function fixedMapTransform(x,y,offsetX=0,offsetY=0){
  const inverse = markerScale(ui.map.getBoundingClientRect?.(), state.box, state.view.k);
  return markerTransform(x, y, inverse, offsetX, offsetY);
}
function currentInverse(){
  return markerScale(ui.map.getBoundingClientRect?.(), state.box, state.view.k);
}
function pinMapElement(element,x,y,offsetX=0,offsetY=0){
  for (const [name, value] of Object.entries(pinAttributes(x, y, offsetX, offsetY))) {
    element.setAttribute(name, value);
  }
  element.setAttribute("transform", fixedMapTransform(x, y, offsetX, offsetY));
  return element;
}
function syncFixedMapElements() {
  const rect = ui.map.getBoundingClientRect?.();
  const inverse = markerScale(rect, state.box, state.view.k);
  for (const element of ui.viewport.querySelectorAll("[data-fixed-map]")) {
    const pin = readPin(element);
    element.setAttribute("transform", markerTransform(pin.x, pin.y, inverse, pin.offsetX, pin.offsetY));
  }
  // Lanes are held at a constant screen separation, which means the path itself
  // has to be redrawn when the zoom changes - a transform cannot do it, because
  // the offset must scale while the endpoints must not.
  //
  // Only when the zoom changes. Panning moves the camera without changing the
  // inverse, and a drag redrawing several hundred paths a frame for no visible
  // difference is the kind of cost that is never noticed until it is the reason
  // the map feels heavy.
  if (inverse !== lastLaneInverse) {
    lastLaneInverse = inverse;
    for (const element of ui.viewport.querySelectorAll("[data-lane]")) {
      const lane = readLane(element);
      element.setAttribute("d", lanePath(lane.from, lane.to, lane.offset, inverse));
    }
  }
  if (state.mode !== "region" || !rect?.width || !rect?.height || !state.positions) return;
  const markers = state.nodes.map(node => {
    const p = state.positions.get(node.record);
    const selected = node.record.system_id === state.selected;
    const screen = worldToScreen(p, state.view, rect, state.box);
    return {
      id: node.record.system_id, node, selected,
      x: screen.x,
      y: screen.y,
      width: Math.max(68, node.record.name.length * 7 + 20),
      padding: node.el.querySelector(".sov-ring") ? 4 : 0,
      dotRadius: node.el.querySelector(".sov-ring") ? 9 : 4,
      priority: (selected ? 1000000 : 0)
      + (node.el.classList.contains("route-endpoint") ? 100000 : 0)
      + (node.el.classList.contains("on-route") || node.el.classList.contains("on-jump") ? 10000 : 0)
      + (state.constellation === String(node.record.constellation_id) ? 1000 : 0)
      + node.record.neighbors.length,
      };
    });
  const shown = chooseMarkerLabels(markers, rect.width, rect.height, previousMarkerLabels);
  previousMarkerLabels = shown;
  const atPoint = new Map();
  for (const marker of markers) {
    marker.node.el.classList.toggle("compact", !shown.has(marker.id));
    const p = state.positions.get(marker.node.record);
    atPoint.set(`${p.x},${p.y}`, marker);
  }
  for (const element of ui.viewport.querySelectorAll(".route-badge-group,.range-node-anchor")) {
    const marker = atPoint.get(`${element.getAttribute("data-fixed-x")},${element.getAttribute("data-fixed-y")}`);
    if (!marker) continue;
    const compact = !shown.has(marker.id);
    element.classList.toggle("compact", compact);
    const outline = element.querySelector(".range-node");
    if (outline) {
      const width = compact ? 14 : marker.width + RANGE_OUTLINE_PADDING;
      const height = compact ? 14 : RANGE_OUTLINE_HEIGHT;
      for (const [name, value] of Object.entries({x: -width / 2, y: -height / 2, width, height, rx: height / 2})) {
        outline.setAttribute(name, value);
      }
    }
  }
  for (const label of ui.viewport.querySelectorAll(".constellation-label")) {
    const pin = readPin(label);
    const { x, y } = worldToScreen(pin, state.view, rect, state.box);
    const halfWidth = label.textContent.length * 4;
    label.classList.toggle("label-crowded", markers.some(m => shown.has(m.id)
    && Math.abs(m.x - x) < m.width / 2 + halfWidth + 4 && Math.abs(m.y - y) < 30));
  }
}
function applyView(){
  ui.viewport.setAttribute("transform", viewTransform(state.view));
  syncFixedMapElements();
}
function zoom(f,cx=state.box[0]/2,cy=state.box[1]/2){
  const unit = markerScale(ui.map.getBoundingClientRect?.(), state.box, 1);
  state.view = zoomedView(state.view, f, cx, cy, unit);
  applyView();
}
function clear(){
  ui.viewport.replaceChildren();
  state.nodes=[];
  state.selected=null;
  state.constellation="all";
  previousMarkerLabels=new Set();
  previousMapRect=ui.map.getBoundingClientRect?.();
  resetView()
}
function metrics(rows){
  ui.metrics.innerHTML=rows.map(([v,l])=>`<div class="metric"><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join("")
}
function legend(mode){
  ui.legend?.remove();
  const element = document.createElement("div");
  element.id = "legend";
  element.className = "legend";
  element.innerHTML = legendMarkup(mode, {
    jump: Boolean(state.jumpIndex),
    route: Boolean(state.routeIndex),
    range: Boolean(state.range),
    threat: Boolean(state.threat),
    ambient: ambientKnown(),
    timers: campaignsKnown(),
    excluded: Boolean(activeLimitCount()),
  });
  ui.map.parentElement.appendChild(element);
  ui.legend = element;
}
function renderRegionList(){
  ui.regionCount.textContent=state.index.length;
  ui.regions.innerHTML="";
  for(const r of state.index){
    const b=document.createElement("button");
    b.className="region-item"+(state.region?.region.name===r.name?" active":"");
    b.innerHTML=`<span>${esc(r.name)}</span><small>${r.system_count}</small>`;
    b.onclick=()=>loadRegion(r.name);
    ui.regions.appendChild(b)
  }
}
function renderUniverse(){
  state.mode="universe";
  state.regionRequestId+=1;
  setViewBox("universe");
  clear();
  ui.universeTab.classList.add("active");
  ui.regionTab.classList.remove("active");
  ui.title.textContent="Universe overview";
  ui.eyebrow.textContent="NEW EDEN / STARGATE REGIONS";
  ui.constellations.hidden=true;
  ui.layoutBar.hidden=true;
  legend("universe");
  const hasGates=r=>r.systems.some(id=>state.atlas.systems[id]?.neighbors.length),regions=Object.values(state.atlas.regions).filter(r=>r.systems.length&&r.position.some(Boolean)&&hasGates(r)),projection=projectionOf(regions,r=>[r.position[0],-r.position[2]],state.box[0],state.box[1],40),pos=project(regions,r=>[r.position[0],-r.position[2]],state.box[0],state.box[1],40),byId=state.atlas.regions,done=new Set;
  state.projection=projection;
  const radiusOf=r=>Math.max(4,Math.min(10,3.5+Math.sqrt(r.system_count)/2)),sideOf=r=>pos.get(r).x>state.box[0]*.55?"left":"right",boxOf=r=>labelBox(r,sideOf(r)),home=labelAnchors(regions,pos,sideOf,radiusOf),labels=new Map(regions.map(r=>[r,{...home.get(r)}]));
  relaxLabels(regions,labels,boxOf,{tether:.002,damping:.6,passes:900,anchors:home,obstacles:regions.map(r=>({...pos.get(r),r:radiusOf(r)})),bounds:{left:8,right:state.box[0]-8,top:16,bottom:state.box[1]-16}});
  const labelled=selectLabels(regions,labels,boxOf,r=>r.system_count);
  state.positions=pos;
  const gatedSystems=Object.values(state.atlas.systems).filter(sys=>sys.neighbors.length).length;
  metrics([[regions.length,"regions mapped"],[gatedSystems.toLocaleString(),"systems on the network"],[state.atlas.jumps.length.toLocaleString(),"stargate links"]]);
  for(const j of state.atlas.jumps){
    if(j.from_region_id===j.to_region_id)continue;
    // Numeric, not lexicographic. `sort()` with no comparator compares as text,
    // which happens to agree with numeric order only because every region id in
    // New Eden is eight digits long. The key is meant to be canonical for an
    // unordered pair, so it should be canonical by construction rather than by a
    // property of the data nothing here checks.
    const key=[j.from_region_id,j.to_region_id].sort((a,b)=>a-b).join("-");
    if(done.has(key))continue;
    done.add(key);
    const a=pos.get(byId[j.from_region_id]),b=pos.get(byId[j.to_region_id]);
    if(a&&b)ui.viewport.appendChild(S("line",{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:"edge boundary"}))
  }
  for(const r of regions){
    const p=pos.get(r),lp=labels.get(r),g=S("g",{class:`region-node ${regionType(r)}`,tabindex:"0",role:"button"}),rad=radiusOf(r),left=sideOf(r)==="left";
    g.append(S("circle",{cx:p.x,cy:p.y,r:rad}));
    if(labelled.has(r)){
      if(Math.hypot(lp.x-(p.x+(left?-rad-5:rad+5)),lp.y-(p.y+4))>7)g.append(S("line",{x1:p.x+(left?-rad:rad),y1:p.y,x2:lp.x+(left?2:-2),y2:lp.y-4,class:"label-leader"}));
      g.append(S("text",{x:lp.x,y:lp.y,"text-anchor":left?"end":"start"},r.name))
    }
    g.onclick=()=>selectRegion(r);
    g.ondblclick=()=>loadRegion(r.name);
    g.onmouseenter=e=>tip(e,r.name,`${r.system_count} systems · double-click to open`);
    g.onmouseleave=hideTip;
    g.onkeydown=e=>{
      if(e.key==="Enter")loadRegion(r.name)
    };
    ui.viewport.appendChild(g);
    state.nodes.push({el:g,record:r})
  }
  renderOverlay()
}
function selectRegion(r){
  state.nodes.forEach(n=>n.el.classList.toggle("selected",n.record.region_id===r.region_id));
  showRegion(r)
}
async function loadRegion(name,focus=null){
  const requestId=++state.regionRequestId;
  ui.loading.style.display="flex";
  try{
    const region=await loadRegionData(name);
    if(requestId!==state.regionRequestId)return;
    state.region=region;
    state.mode="region";
    renderRegionList();
    renderRegion(focus)
  }catch(e){
    if(e.name!=="AbortError"&&requestId===state.regionRequestId){
      ui.title.textContent="Archive read failed";
      console.error(e)
    }
  }finally{
    if(requestId===state.regionRequestId)ui.loading.style.display="none"
  }
}
function renderRegion(focus = null) {
  state.mode = "region";
  setViewBox("region");
  clear();
  state.projection = null;
  const d = state.region;
  const systems = Object.values(d.systems);
  const layout = regionLayout(systems, state.layoutMode, ...state.box, { relax: relaxSystems, projectWith: project });
  const pos = layout.positions;
  state.positions = pos;
  state.layout = layout;
  ui.universeTab.classList.remove("active");
  ui.regionTab.classList.add("active");
  ui.regionTab.disabled = false;
  ui.title.textContent = d.region.name;
  ui.eyebrow.textContent = "REGION / STARGATE TOPOLOGY";
  ui.constellations.hidden = false;
  metrics([[systems.length, "systems"], [Object.keys(d.constellations).length, "constellations"], [d.jumps.length, "internal gates"]]);
  legend("region");
  renderConstellations();
  renderLayoutBar();
  for (const c of Object.values(d.constellations)) {
    const members = c.solar_system_ids.map(id => d.systems[id]).filter(Boolean);
    if (!members.length) continue;
    const pts = members.map(s => pos.get(s));
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const r = Math.max(48, Math.max(...pts.map(p => Math.hypot(p.x - cx, p.y - cy))) + 32);
    ui.viewport.appendChild(S("circle", {cx, cy, r, class: "constellation-ring", "data-c": c.constellation_id}));
    ui.viewport.appendChild(pinMapElement(S("text", {x: 0, y: 0, class: "constellation-label", "data-c": c.constellation_id}, c.name), cx, cy - r + 16));
  }
  // Links that would be drawn on top of each other are moved apart first, so
  // each keeps its own line and its own colour. Kept on state because the
  // route overlay draws over these same lanes and has to land on them.
  lastLaneInverse = null;
  const drawable = d.jumps.filter(j => d.systems[j.from_system_id] && d.systems[j.to_system_id]);
  const lanes = assignLaneOffsets(drawable,
    j => [pos.get(d.systems[j.from_system_id]), pos.get(d.systems[j.to_system_id])]);
  state.lanes = new Map(drawable.map(j =>
    [`${j.from_system_id}-${j.to_system_id}`, lanes.offsets.get(j) ?? 0]));
  for (const j of d.jumps) {
    const a = d.systems[j.from_system_id], b = d.systems[j.to_system_id];
    if (!a || !b) continue;
    const offset = lanes.offsets.get(j) ?? 0;
    ui.viewport.appendChild(S("path", {
      ...laneAttributes(pos.get(a), pos.get(b), offset),
      d: lanePath(pos.get(a), pos.get(b), offset, currentInverse()), class: "edge",
      "data-a": a.constellation_id, "data-b": b.constellation_id,
      "data-jump": `${j.from_system_id}-${j.to_system_id}`,
      }));
  }
  for (const s of systems) {
    const p = pos.get(s);
    const boundary = s.neighbors.some(id => !d.systems[id]);
    const w = Math.max(68, s.name.length * 7 + 20);
    const color = boundary ? "#d9b95b" : secColor(s.security);
    const g = pinMapElement(S("g", {
      class: "system-node", tabindex: "0", role: "button", "data-c": s.constellation_id,
      "aria-label": `${s.name}, security ${secFormat(s.security)}, ${s.neighbors.length} gates`,
      }), p.x, p.y);
    g.append(S("circle", {cx: 0, cy: 0, r: 12, class: "system-hit", fill: "transparent"}));
    g.append(S("circle", {cx: 0, cy: 0, r: 4, class: "system-dot", fill: secColor(s.security), stroke: color}));
    // Sovereignty is a ring around the dot rather than a recolouring of it:
    // the dot already means security, and taking that over would trade one
    // fact for another instead of adding one.
    const holding = sovHolderOf(s.system_id);
    if (holding) {
      g.append(S("circle", {
        cx: 0, cy: 0, r: 8, class: "sov-ring",
        stroke: allianceColour(holding.alliance_id),
        "data-sov": holding.alliance_id,
      }));
    }
    // Drawn from the same constant the lane fan is sized against, so the two
    // cannot drift apart. A fan wider than this capsule leaves links finishing
    // outside the node they connect to.
    const nodeH = SYSTEM_NODE_HEIGHT;
    g.append(S("rect", {x: -w / 2, y: -nodeH / 2, width: w, height: nodeH, rx: nodeH / 2, fill: "#11181d", stroke: color}));
    if (holding) {
      g.append(S("rect", {
        x: -w / 2 - HALO_PADDING / 2, y: -HALO_HEIGHT / 2,
        width: w + HALO_PADDING, height: HALO_HEIGHT, rx: HALO_HEIGHT / 2,
        class: "sov-outline", fill: "none", stroke: allianceColour(holding.alliance_id),
        style: `--sov-colour: ${allianceColour(holding.alliance_id)}`,
        "data-sov": holding.alliance_id,
      }));
    }
    g.append(S("text", {x: 0, y: -1, class: "system-name"}, s.name));
    g.append(S("text", {x: 0, y: 10, class: "system-info"}, `${secFormat(s.security)} · ${s.neighbors.length} GATES`));
    g.append(S("path", {class: "contested-mark contested-label", d: "M-5 -11l3 -4 M1 -11l3 -4"}));
    g.append(S("path", {class: "contested-mark contested-dot", d: "M3 -6l3 -3 M7 -3l3 -3"}));
    g.onclick = () => selectSystem(s.system_id);
    g.onmouseenter = e => tip(e, s.name, `${d.constellations[s.constellation_id]?.name} · security ${secFormat(s.security)}`);
    g.onmouseleave = hideTip;
    g.onkeydown = e => {
      if (e.key === "Enter") selectSystem(s.system_id);
    };
    ui.viewport.appendChild(g);
    state.nodes.push({el: g, record: s});
  }
  renderOverlay();
  showRegion(d.region);
  ui.inspector.classList.remove("open");
  if (focus && d.systems[focus]) selectSystem(focus);
}
// **The contact route CCP would use, if this build has one.**
//
// `esi.js` defaults to naming the application and its publisher and nothing else, and
// carries a route only when one is set. Read once at startup: whoever publishes a
// build sets it, a pilot never does, and an unset one is honest rather than broken -
// CCP can still identify the application, which is the part they ask for.
setContactRoute(readText(localStorage, STORAGE_KEYS.contact) ?? "");

const LAYOUT_KEY = STORAGE_KEYS.layout;
const TACTICAL_KEY = STORAGE_KEYS.tactical;
const READ_KEY = STORAGE_KEYS.read;
// Which layout is drawn, and - when the two differ - saying so. A region with
// no published layout silently drawing the other one would be the map lying
// about whose map it is.
function renderLayoutBar(){
  const layout=state.layout;
  if(!layout){
    ui.layoutBar.hidden=true;
    return
  }
  ui.layoutBar.hidden=false;
  for(const button of[ui.layoutAtlas,ui.layoutCcp])button.setAttribute("aria-pressed",String(button.dataset.layout===layout.mode));
  ui.layoutCcp.disabled=layout.fellBack;
  ui.layoutNote.textContent=layout.fellBack?"CCP publishes no layout for this region - showing the Atlas schematic.":layout.mode==="ccp"?"CCP's own map, drawn exactly as published.":""
}
function setLayoutMode(mode){
  state.layoutMode = LAYOUT_MODES.includes(mode) ? mode : "ccp";
  writeText(localStorage, LAYOUT_KEY, state.layoutMode);
  if (state.mode === "region" && state.region) renderRegion(state.selected);
}
function restoreLayoutMode(){
  state.layoutMode = readText(localStorage, LAYOUT_KEY, LAYOUT_MODES) ?? "ccp";
}
function bindLayout(){
  restoreLayoutMode();
  for(const button of[ui.layoutAtlas,ui.layoutCcp])button.onclick=()=>setLayoutMode(button.dataset.layout)
}
// --- anything driven by the clock --------------------------------------------
//
// The formatter lives in live-time.js, shared by the templates that render a
// time, the tick that refreshes them, and the bars that embed one mid-line.

// Every live surface, refreshed together. One layer on the timer advances while the
// rest sit frozen at whatever they said when they were last drawn.
function renderLiveAges() {
  renderSovereigntyStatus();
  renderAmbientStatus();
  renderActivityStatus();
  renderCampaignStatus();
  tickLiveTimes();
}

function tickLiveTimes(now = Date.now()) {
  // `refreshScout` recalculates the route itself when the set it can route over has
  // changed - see the note on it. A comparison around this call cannot fire, because
  // `syncScoutLayer` has already refreshed.
  refreshScout(now);
  // A timer that starts while the panel is open.
  //
  // The countdown carries its own instant and the tick recomputes it, while
  // "Scheduled" and "Under attack" are decided at render and baked into the markup.
  // So a campaign crossing its start time leaves the tag reading "Scheduled" beside
  // its own countdown reading "started 2m ago", with the map still drawing it as
  // upcoming - and telling a fight to join from a fight to plan for is the whole point
  // of the layer.
  if (campaignsKnown()) {
    const live = liveNow(state.live, now).length;
    if (live !== state.campaignsLive) {
      state.campaignsLive = live;
      refreshOpenInspector();
      markCampaigns();
      renderCampaignStatus();
    }
  }
  // `ui.askLayer` is a root because the window is not inside `ui.content`.
  //
  // It is deliberately outside `main`, because a floating panel anchored inside a
  // scrolling container drifts away from the thing it is about - which also puts it
  // outside the roots this tick would otherwise walk. Missed, the header age is
  // correct exactly once, at render, and a window left open for an hour goes on
  // saying the brief was taken just now. Its own age in its header, always, is how a
  // pilot tells two windows apart.
  return refreshLiveTimes([ui.content, ui.ignoreList, ui.bridgeList, ui.scoutList, ui.askLayer], now);
}

// An inspector left open across a sync is showing the previous sync's facts.
// Redrawing it is not only about the age: holders change hands, timers start,
// and kills arrive.
function refreshOpenInspector() {
  // Only when a system inspector is what is actually open. `state.selected`
  // outlives every panel - it is not cleared by `display` - so this read it and
  // redrew a system panel over a route, a jump plan, a range set or a brief on
  // every sync and every tick. See the note on `display`.
  if (state.panel !== "system") return;
  const selected = state.selected;
  if (selected === null || selected === undefined) return;
  const system = state.region?.systems?.[selected];
  if (system) showSystem(system);
}

// --- sovereignty -------------------------------------------------------------
//
// The live store, kept entirely apart from the archive: a separate key, its own
// schema, and a rebuild of the archive cannot touch it. Nothing here is allowed
// to stop the map drawing, because the map works offline and this does not.
const LIVE_KEY = "new-eden-atlas-live-v1";
// The shape `persistLive` writes, and **read as well as written**.
//
// Every reader below degrades rather than throwing, so a store whose shape has moved
// on comes back as zero observations - which is right for keeping the map drawing, and
// fatal if the next `persistLive` then writes that empty store over the save it could
// not read. A disappearance is itself the intelligence and is never deleted; losing
// the log to a version bump would delete all of them at once, silently, on startup.
//
// So a save whose schema is not this one is left alone: read nothing from it, write
// nothing over it, and say so.
const LIVE_SCHEMA = 1;
let sovAgeTimer = null;

// --- where the live store is kept ------------------------------------------------
//
// Two tiers, one store. The browser keeps it in local storage, which has a hard
// quota of a few megabytes; the shell hands it to the core, which writes a real
// file and has no quota at all. The choice is made here and nowhere else, so
// every caller of persistLive and restoreLive is unaware of it - and the
// browser path is left exactly as it was, because the zero-install tier is the
// graceful-degradation law applied to packaging.
//
// Detection is synchronous on purpose. Asking the core whether it exists would
// itself be an async call, which is the thing being avoided.
// --- the one door to the core ------------------------------------------------------
//
// Every call into the shell goes through here, and nothing else in this file
// names a Tauri command.
//
// The point is `request()`. It validates a payload against the declared shape
// before anything is sent - including the routing law, that an op taking a
// `characterId` takes exactly one, so `characterId: [1, 2]` cannot leave this
// process. That check existed and ran only in `contract.test.mjs`, which meant
// the application had a second, unvalidated vocabulary and the contract was
// describing a shape nothing was held to. `token.begin` had drifted to
// declaring a `scopes` array the real command has never accepted.
//
// WHAT IS ADOPTED, AND WHAT IS NOT.
//
// The vocabulary and the validation. Not the envelope: `request()` returns
// `{ v, id, op, payload }` for a transport that has to correlate its own
// replies, and Tauri's `invoke` is already a correlated request and response.
// So the id is built and discarded here on purpose. When the advisor arrives
// over a pipe that is not request-and-response, the envelope is waiting and
// this is the only function that changes.
//
// The Rust command names are unchanged, deliberately. Renaming six
// `#[tauri::command]` functions to match dotted op names would churn the
// handler list and every check that mentions them, for no behaviour.
const CORE_COMMANDS = Object.freeze({
  "sightings.load": "sightings_load",
  "sightings.save": "sightings_save",
  "token.begin": "token_begin",
  "token.characters": "token_characters",
  "token.forget": "token_forget",
  "portrait.get": "character_portrait",
  "advisor.available": "advisor_status",
});

// A random per-realm prefix plus a counter, for the reason `snapshot.js`
// already gives about snapshot ids: a counter alone lets two page loads both mint the
// same id, and a reference from one then resolves in the other.
//
// Decorative while Tauri correlates each `invoke` by its own promise. It stops being
// decorative once the advisor hop carries the envelope over one pipe, because the core
// then routes replies **by envelope id** and one window's "1" is another window's "1".
const CORE_REALM = Math.random().toString(36).slice(2, 10);
let coreRequestId = 0;

// Declared and dark: the shape is decided, nothing answers them yet.
//
// Data rather than a sentence, because `contract.test.mjs` asserts that every
// declared op is either routed or listed here - no op can be added to the
// contract and quietly go nowhere, and none can be routed without being
// declared. That partition is exactly the drift that had `character_portrait`
// shipping outside the vocabulary, and a comment asking the next person to
// remember is what let it happen.
//
// A stub returning null would be worse than a refusal: the caller would read it
// as "no data", which is the absence-of-observation mistake this project spends
// most of its rules on - about a request that was never made.
// Declared and routed nowhere. `esi.get` is the only one: it has a shape and no
// implementation, and a caller reaching for it is told so rather than handed null.
const DARK_OPS = Object.freeze(["esi.get"]);

// --- one protocol, two transports, and now the table says so ----------------
//
// `CORE_COMMANDS` maps an op to a **typed Tauri command**. Two ops may not
// share one, because a typed command carries no op name and is told apart only
// by which command was called - send the wrong payload and it lands in the
// wrong place with no way to notice.
//
// The advisor pipe is not that. It carries the **whole envelope**, `op`
// included, so two ops sharing it is how it is meant to work: telling them
// apart is precisely what the envelope is for. Keeping them in a second table
// means the distinctness rule stays exactly as strong where it is true, instead
// of being weakened everywhere to accommodate a case it was never about.
const ADVISOR_COMMANDS = Object.freeze({
  "advisor.consider": "advisor_request",
  "advisor.ask": "advisor_request",
});

function sendCore(op, payload = {}) {
  // **One shape out, always.** Every exit resolves an envelope, so a caller writing
  // `sendCore(op, x).then(envelope => ...)` cannot get an unhandled rejection from
  // one path and an envelope from another. A protocol with two outcome shapes is two
  // protocols.
  //
  // `callCore` still turns a failure envelope into a rejection, because its six
  // callers all handle failure with `.catch` and a resolved failure would read as
  // success.
  //
  // `nextCoreId`, not a second copy of it: one place mints a request id, because two
  // would eventually disagree about the prefix.
  const id = nextCoreId();
  const invoke = coreStore();
  if (!invoke) {
    return Promise.resolve(failure(id, "core-absent", `${op}: this build has no core, so there is nothing to ask`));
  }
  let envelope;
  try {
    // Throws on an unknown op and on a payload that does not match the declared
    // shape. Rejected rather than thrown, so every caller handles failure the
    // one way - with `.catch` - instead of some of them needing try/catch.
    envelope = request(op, payload, { id });
  } catch (error) {
    return Promise.resolve(failure(id, "malformed", reason(error)));
  }
  if (!Object.hasOwn(CORE_COMMANDS, op)) {
    const dark = DARK_OPS.includes(op);
    // Named rather than lumped in with "routes it nowhere". An advisor op sent
    // through this door is a caller that reached for the wrong transport, and
    // saying so is the difference between a five-second fix and an afternoon.
    if (Object.hasOwn(ADVISOR_COMMANDS, op)) {
      // `malformed`, not `core-absent`. A caller may branch on `core-absent` -
      // it is the declared fact "this build has no core" - and using it for
      // "you called the wrong function" makes a programming mistake
      // indistinguishable from a real absence. `sendAdvisor`'s mirror of this
      // case already says `malformed`.
      return Promise.resolve(failure(id, "malformed",
        `${op} is carried to the advisor, not to the core - use sendAdvisor`));
    }
    return Promise.resolve(failure(id, "core-absent",
      dark
        ? `${op} is specified but not implemented in this build, so it was refused rather than answered`
        : `${op} is declared but this build routes it nowhere`));
  }
  // **One protocol, two transports.**
  //
  // The **whole envelope** crosses, not only `envelope.payload`. Sending the payload
  // alone leaves `v`, `id` and `op` never reaching the core, and `parseMessage`,
  // `reply`, `failure` and `isReplyTo` with no production caller at all - a contract
  // whose envelope layer is test-only.
  //
  // A Tauri command is a typed transport: Rust deserialises `character_id: i64`
  // at its own boundary, which is a real check worth keeping, and it returns a
  // bare value rather than an envelope. So the payload goes down and the reply
  // comes back wrapped here, and every caller sees one shape whichever
  // transport carried it. The advisor hop is the other case - a pipe with no
  // type system - and carries the whole envelope; it gets its own command when
  // it leaves DARK_OPS.
  // `invoke` is foreign code, and it throwing **before** it returns a promise is the
  // last escape from a function that promises an envelope.
  //
  // Caught rather than deferred behind `Promise.resolve().then(...)`. That
  // would work too and would move the call one microtask later, which is a
  // behaviour change dressed as a guard - two tests that drive a save and then
  // reach for its resolver found it immediately. The protection is the same
  // and the timing is not touched.
  //
  // `Promise.resolve(...)` around the result because a bridge that returns
  // something other than a promise would otherwise throw on `.then`.
  //
  // The failure is rendered through `reason`, which cannot throw: this catch
  // read `error?.message` directly, so a hostile getter defeated the very
  // handler that exists to describe hostile input.
  let started;
  try {
    started = invoke(CORE_COMMANDS[op], envelope.payload);
  } catch (error) {
    return Promise.resolve(failure(envelope.id, "refused", reason(error)));
  }
  return Promise.resolve(started)
    .then((value) => reply(envelope.id, payloadOf(op, value)))
    .catch((error) => failure(envelope.id, "refused", reason(error)));
}

// One place mints a request id, because two would eventually disagree about
// the prefix and the prefix is what stops two windows minting the same one.
function nextCoreId() {
  return `c${CORE_REALM}-${(coreRequestId += 1)}`;
}

// The advisor hop. Beside `sendCore`, not inside it.
//
// `sendCore` sends `envelope.payload` and throws the envelope away, which is right for
// a typed command: Rust deserialises the payload at its own boundary and returns a bare
// value. The advisor is a pipe with no type system on the far end, and both of its
// staleness checks need the envelope - the id to say "this answers my question", the
// `snapshotId` to say "about the brief on screen". Reusing `sendCore` would drop the id
// and leave `consider` with nothing to check.
//
// **Total, like `sendCore`:** every exit resolves an envelope. A caller writing
// `.then(envelope => ...)` never gets an unhandled rejection.
function sendAdvisor(op, payload = {}, { id = nextCoreId() } = {}) {
  const invoke = coreStore();
  if (!invoke) {
    return Promise.resolve(failure(id, "core-absent", `${op}: this build has no core, so there is nothing to ask`));
  }
  let envelope;
  try {
    envelope = request(op, payload, { id });
  } catch (error) {
    return Promise.resolve(failure(id, "malformed", reason(error)));
  }
  if (!Object.hasOwn(ADVISOR_COMMANDS, op)) {
    return Promise.resolve(failure(id, "malformed", `${op} is not an op the advisor answers`));
  }
  let started;
  try {
    started = invoke(ADVISOR_COMMANDS[op], { envelope });
  } catch (error) {
    return Promise.resolve(failure(envelope.id, "sidecar-absent", reason(error)));
  }
  return Promise.resolve(started)
    .then((value) => {
      // The whole envelope comes back, and is **read rather than trusted**.
      // Its id is deliberately not rewritten to ours: an envelope answering a
      // different request has to reach `consider` still saying so, or the one
      // check that catches a slow reply landing under a newer brief is the
      // check that quietly repaired it.
      const parsed = parseMessage(value);
      if (!parsed.ok) {
        // **The code is carried, not collapsed.** This said `malformed` for
        // everything, so a sidecar built against a later contract reported
        // `version-mismatch` and the pilot was told the reply was malformed -
        // the one unrecoverable condition, renamed to a retryable one. The
        // codes are a closed vocabulary a caller branches on, and `contract.js`
        // spends fifty lines on why conflating them breaks a law rather than a
        // feature.
        return failure(envelope.id, parsed.error.code,
          `the advisor answered with something this build cannot read: ${parsed.error.message}`);
      }
      return parsed.message;
    })
    .catch((error) => failure(envelope.id, "sidecar-absent", reason(error)));
}

// The value, for the six callers that want one.
//
// `sendCore` is the protocol and this is an adapter over it: a typed Tauri
// command returns a bare value and its callers want a bare value, so unwrapping
// here keeps that convenience without the envelope being a fiction. A failure
// envelope becomes a rejection, because every existing caller handles failure
// with `.catch` and a resolved failure would be read as success.
function callCore(op, payload = {}) {
  return sendCore(op, payload).then((held) => {
    // Read rather than trusted. `sendCore` stamps `v: CONTRACT_VERSION` onto an
    // answer the core never versioned - true today, because the core is
    // compiled from this same tree, and a claim nothing checked. Running
    // `parseMessage` over it costs nothing, gives the version layer its first
    // production caller, and means the day the core gains a version of its own
    // this hop already refuses a mismatch instead of asserting agreement.
    const parsed = parseMessage(held);
    if (!parsed.ok) throw new Error(`${op} answered with something this build cannot read: ${parsed.error.message}`);
    const envelope = parsed.message;
    if (envelope.ok === false) throw new Error(envelope.error.message || envelope.error.code);
    // The core's replies are held to the same declared shape the advisor's are.
    // `REPLIES` exists because the reply is the direction most easily left unchecked,
    // and wiring it into the advisor path alone would leave the six core commands
    // unwatched.
    //
    // The core is our own Rust rather than a foreign process, so this is not about a
    // hostile answer: it is about a return type changing on one side of a boundary with
    // nothing saying so, and a silent shape drift here hands a caller `null` where it
    // expected a store.
    const bad = replyFault(op, envelope.payload);
    if (bad) throw new Error(`${op} answered with something this build does not understand: ${bad}`);
    const field = CORE_REPLY_FIELD[op];
    if (field === null) return undefined;
    return Object.hasOwn(envelope.payload, field) ? envelope.payload[field] : null;
  });
}

// A typed command returns the thing itself; the contract says which field of
// the reply payload it is. Declared in one place so a command and its reply
// cannot drift, and so a caller never has to know which shape it is holding.
const CORE_REPLY_FIELD = Object.freeze({
  "sightings.load": "store",
  "sightings.save": "bytes",
  "token.begin": "character",
  "token.characters": "characters",
  "token.forget": null,
  "portrait.get": "dataUrl",
  "advisor.available": "running",
});

function payloadOf(op, value) {
  // **Declared, not defaulted.** `null` here means "this command returns
  // nothing", which `token.forget` genuinely does - so a missing row read as
  // the same thing, and routing a new op without adding one would hand every
  // caller `undefined` with a green suite and no error. `esi.get` is next, and
  // `REPLIES` already declares a body for it.
  if (!Object.hasOwn(CORE_REPLY_FIELD, op)) {
    throw new Error(`${op} is routed to the core but no reply field is declared for it`);
  }
  const field = CORE_REPLY_FIELD[op];
  if (field === null) return {};
  // A `null` from the core becomes an absent field, and `callCore` turns an
  // absent field back into `null` - so the protocol layer in between cannot
  // express the difference between "the core had nothing" and "the core
  // returned null". That is fine for the two fields `REPLIES` marks optional
  // and it is the whole round trip for them; for the four required ones a null
  // produces a payload `replyFault` then refuses, which is the right outcome
  // and not one this line arranges.
  //
  // Absent and null are **not** kept apart here, deliberately. Where the distinction
  // is load-bearing it is kept in Rust: `load_store` returns `Ok(None)` only for a
  // missing file, and an empty or non-object file is an `Err`, so a `null` reaching
  // the viewer does mean "no store yet" rather than "a store that read as nothing".
  return value === undefined || value === null ? {} : { [field]: value };
}

// The sentence a pilot reads, out of whatever the transport threw.
//
// All six Rust commands return `Result<_, String>`, so `invoke` rejects with a bare
// string - and `callCore` wraps a failure envelope in an `Error` to keep its rejection
// contract, where `String(error)` prepends "Error: " and the 120-character truncations
// lose seven characters of a path.
//
// Reading `.message` first survives whatever the transport wraps next, which is the
// point: these strings have arrived in three shapes so far.
function reason(error) {
  if (error === null || error === undefined) return "";
  // Guarded, because the thing being rendered is whatever the transport threw.
  // Reading `.message` runs a getter and `String()` runs a `toString`, and a
  // hostile or merely broken one took this function with it - inside the
  // handler whose whole job is to turn a failure into a sentence.
  try {
    const message = typeof error === "object" && typeof error.message === "string" ? error.message : null;
    if (message !== null && message !== "") return message;
  } catch {
    return "the failure could not be described";
  }
  try {
    return String(error);
  } catch {
    return "the failure could not be described";
  }
}

function coreStore() {
  const invoke = typeof window === "undefined" ? null : window.__TAURI__?.core?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

// Nothing may be written until the first read has resolved, one way or another.
//
// A write that fires before the load lands replaces a good file with the empty
// store the application started with - the same wipe as a truncating write,
// arriving through a different door, and harder to see because the application
// looks like it started perfectly.
//
// All three load outcomes settle it, including the refusal: a corrupt file must
// stop the writes permanently rather than delay them, or the gate is only a
// pause before the same deletion.
//
// Mutations made before it settles are DROPPED, never queued. Replaying them
// afterwards would be the third door: memory after a refused load is not
// authority over the file, and a queue flushed at that moment writes an empty
// store over a damaged one that might still have been recoverable by hand.
// Long enough to swallow a burst of toggles, short enough that closing the
// window a moment later still flushes rather than races.
const CORE_WRITE_DELAY_MS = 400;
// Starts closed. A flag whose entire job is "refuse until proven safe" defaults to
// refusing, or a write between module evaluation and `restoreLive()` goes straight
// through with an empty store - held off by ordering luck rather than by construction.
// The browser branch sets it true synchronously, which leaves that tier unchanged.
let liveLoadSettled = false;
let liveWriteRefused = false;
let pendingCoreWrite = null;
// Which load the answers belong to.
//
// The gate was three booleans with no sense of *which* load settled them, so a
// second restoreLive did not invalidate the first one's in-flight promise. Load
// A resolving would open the gate for load B, which had already wiped the store
// to empty - and the next write put that empty store over a good file. The
// failure the gate exists to prevent, reintroduced through re-entrancy. The
// inverse was worse: a rejected first load set liveWriteRefused back to true
// after a healthy second load had cleared it, and nothing ever clears it again,
// so a perfectly readable file disabled saving for the session.
let liveLoadEpoch = 0;

// Write now, rather than in four hundred milliseconds.
//
// The debounce is what stops a thirty-character store being serialised on every
// toggle, and it is also a window in which everything unsaved is lost if the
// application closes. So closing flushes it. Returns the promise so a caller -
// or a test - can wait for the write to land instead of guessing.
function flushLiveWrites() {
  if (!pendingCoreWrite) return Promise.resolve();
  const write = pendingCoreWrite;
  pendingCoreWrite = null;
  clearTimeout(write.timer);
  return write.run();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // `pagehide` rather than `unload`: it fires when a window is closed and also
  // when it is put away without being destroyed, and it is the one modern
  // browsers still guarantee.
  window.addEventListener("pagehide", flushLiveWrites);
}

// **Reading a save and drawing it are different failures, and they were one
// function.** Both call sites wrap this in a `try` whose comment says a throw
// is "a rendering fault, not damage to the store" - which was true of the
// drawing half and false of the reading half, and the reading half came first.
//
// `activityFromJSON` throws on a saved `activitySeries` whose `history` is not
// iterable, and a throw part-way through loading leaves the assignments after it
// unreached. `state.overrides` staying `null` with the write gate already open is the
// worst of them: `overridesToJSON(null)` returns `{version:1,entries:[]}`, which is
// byte-identical to an empty store, so the next `persistLive()` writes that over the
// pilot's real avoid list - permanently, on startup, with the only message on screen
// saying something could not be displayed.
//
// That is the failure `routing-inputs.js` exists to prevent, written to disk: an empty
// avoid list and an uncaptured one are different facts, and after the write a reload
// cannot tell them apart.
//
// So: read, then commit, then draw. A throw while reading is damage and the caller
// refuses writes for the session. A throw while drawing changes nothing about the file
// and saving continues.
function readLiveSave(saved) {
  const parsed = {
    live: saved?.sightings ? sightingsFromJSON(saved.sightings) : createSightings(),
    activity: activityFromJSON(saved?.activitySeries ?? null),
    overrides: saved?.overrides ? overridesFromJSON(saved.overrides) : createOverrides(),
    // The previous response's etag and expiry, so the next request can be
    // conditional and the age shown is the data's rather than the check's.
    sovMeta: saved?.sov ?? null,
    ambientMeta: saved?.ambient ?? null,
    activityMeta: saved?.activity ?? null,
    campaignMeta: saved?.campaigns ?? null,
    scoutMeta: saved?.scout ?? null,
  };
  // Lapsed entries go on load rather than lingering until something else
  // prunes them. An ignore that expired while the tool was closed has expired.
  pruneOverrides(parsed.overrides);
  return parsed;
}

// Assignment only, so that nothing here can throw between two fields and leave
// half a store behind a gate that is already open.
function commitLiveSave(parsed) {
  state.live = parsed.live;
  state.activity = parsed.activity;
  state.overrides = parsed.overrides;
  state.sovMeta = parsed.sovMeta;
  state.sovHeld = null;
  state.ambientMeta = parsed.ambientMeta;
  state.activityMeta = parsed.activityMeta;
  state.campaignMeta = parsed.campaignMeta;
  state.scoutMeta = parsed.scoutMeta;
}

function renderLiveSave() {
  refreshBridges();
  renderAvoidList();
  renderSovereigntyStatus();
  renderAmbientStatus();
  renderActivityStatus();
  renderCampaignStatus();
  refreshScout();
  renderHistoryCount();
}

// The three in order, for the callers that pass `null` - an empty store cannot
// fail to parse, so for them the distinction the split exists for cannot arise.
function applyLiveSave(saved) {
  commitLiveSave(readLiveSave(saved));
  renderLiveSave();
}

function restoreLive() {
  const invoke = coreStore();
  if (!invoke) {
    // The browser tier: a synchronous read, settled immediately - but with the
    // same three outcomes the shell tier has, because it needs them more.
    //
    // `readJsonState`, not `readJson`. The latter returns null for a store that was
    // never written *and* for one that is there and cannot be parsed, so both read as
    // a first run, the write gate opens, and the next sync - every sync, every bridge,
    // every override - writes an empty store over the only copy a browser-tier pilot
    // has, with the shelf saying "Nothing recorded yet." and no error anywhere.
    const { state: outcome, value: stored } = readJsonState(localStorage, LIVE_KEY);
    liveLoadSettled = true;
    if (outcome === "unreadable") {
      // The one copy stays exactly as it is, and nothing is written over it for
      // the rest of the session. A store this page cannot parse may still be
      // recoverable by hand, and it certainly is not recoverable after we
      // replace it.
      liveWriteRefused = true;
      state.persistFailed = true;
      state.liveSchemaMismatch = null;
      if (ui.persistError) {
        ui.persistError.textContent =
          "The saved live history could not be read, so it has been left untouched and nothing "
          + "will be saved this session. It is still in this browser's storage, unchanged.";
      }
      // Guarded like the branch below: restoreLive is called from a binding
      // block init does not wrap, so a throw in here returns from init before
      // the map is loaded and the window opens on nothing.
      try {
        applyLiveSave(null);
      } catch {
        // An empty store that will not render is a rendering fault and changes
        // nothing about the file, which is already being left alone.
      }
      return;
    }
    // A save with no schema at all predates the field and is read as this one,
    // because that is what it is; only a *different* stated schema is refused.
    const foreign = stored !== null && stored.schema !== undefined && stored.schema !== LIVE_SCHEMA;
    state.liveSchemaMismatch = foreign ? stored.schema : null;
    // **Read before the gate opens.** A save this build cannot parse is damage,
    // and the one copy has to be left alone - so `liveWriteRefused` is only
    // cleared once the read has succeeded.
    let parsed;
    try {
      parsed = readLiveSave(foreign ? null : stored);
    } catch (error) {
      liveWriteRefused = true;
      state.persistFailed = true;
      if (ui.persistError) {
        ui.persistError.textContent =
          `Part of the saved live history could not be read (${reason(error).slice(0, 80)}), so it has been left untouched and nothing will be saved this session.`;
      }
      return;
    }
    liveWriteRefused = false;
    commitLiveSave(parsed);
    // Drawing is the other half, and a panel that fails to draw must not stop
    // the store being saved.
    try {
      renderLiveSave();
    } catch (error) {
      if (ui.liveError) {
        ui.liveError.textContent =
          `Live data loaded but could not be displayed: ${reason(error).slice(0, 120)}`;
      }
    }
    return;
  }

  // The shell tier. The read is asynchronous, so the store starts empty and the
  // gate holds every write until the core answers. Callers stay synchronous;
  // init and bindSovereignty are untouched.
  liveLoadSettled = false;
  liveWriteRefused = false;
  state.liveSchemaMismatch = null;
  applyLiveSave(null);

  const epoch = (liveLoadEpoch += 1);
  const mine = () => epoch === liveLoadEpoch;

  callCore("sightings.load").then(stored => {
    if (!mine()) return;
    // Absent means no file, which is a first run and an empty store is right.
    const foreign = stored !== null && stored !== undefined
      && stored.schema !== undefined && stored.schema !== LIVE_SCHEMA;
    state.liveSchemaMismatch = foreign ? stored.schema : null;
    // Two failures, told apart. A fault while **reading** is file damage: the file is
    // left as it is and nothing is written over it for the session. A fault while
    // **drawing** changes nothing about the file, and reporting it as damage would stop
    // saving because a panel failed to draw. One `try` around both cannot tell them
    // apart - see `readLiveSave`.
    let parsed;
    try {
      parsed = readLiveSave(foreign ? null : stored);
    } catch (error) {
      liveWriteRefused = true;
      state.persistFailed = true;
      if (ui.persistError) {
        ui.persistError.textContent =
          `Part of the saved live history could not be read (${reason(error).slice(0, 80)}), so the file has been left untouched and nothing will be saved this session.`;
      }
      return;
    }
    commitLiveSave(parsed);
    try {
      renderLiveSave();
    } catch (error) {
      if (ui.liveError) {
        ui.liveError.textContent =
          `Live data loaded but could not be displayed: ${reason(error).slice(0, 120)}`;
      }
    }
  }).catch(error => {
    if (!mine()) return;
    // Damage. The file stays exactly as it is and nothing is written over it
    // for the rest of the session - the one copy of a pilot's history is worth
    // more than this session's syncs, and a file that cannot be parsed here may
    // still be readable by hand.
    liveWriteRefused = true;
    state.persistFailed = true;
    if (ui.persistError) {
      ui.persistError.textContent =
        "The saved live history could not be read, so it has been left untouched and nothing "
        + `will be saved this session. The file is on disk and unchanged. (${reason(error).slice(0, 120)})`;
    }
  }).finally(() => {
    // Settled covers all three outcomes, refusal included, or the gate becomes
    // a permanent block on a tier that works - but only for the load that is
    // still current. An older load settling the gate for a newer one is how the
    // empty boot store reaches a good file.
    if (mine()) liveLoadSettled = true;
  });
}

// --- the pilot's own history -----------------------------------------------------
//
// The store law says gone is closed and never deleted, and it means never
// deleted *by a sync*. No automatic process may drop a closed window, because a
// disappearance is itself the intelligence. A pilot clearing their own history
// is a different act entirely, and this is the only thing in the application
// that removes one.
//
// Two clicks, and the second is only offered once the first has said exactly
// what will go. A count alone is not informed consent: "remove 1,284 records"
// does not tell a pilot they are about to lose every record of who held Delve
// last month, and the one thing that cannot be undone deserves the sentence.
const HISTORY_AGES = { 30: "a month", 14: "two weeks", 7: "a week", 3: "three days", 1: "a day" };
const DAY_MS = 86_400_000;
let historyArmed = null;

function historyCutoff(value, now = Date.now()) {
  if (value === "all") return Infinity;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? now - days * DAY_MS : null;
}

function renderHistoryCount() {
  if (!ui.historyCount) return;
  const held = state.live ? prunableSightings(state.live, { before: Infinity }) : null;
  if (!held || !held.total) {
    ui.historyCount.textContent = "Nothing recorded yet.";
    ui.historySummary.textContent = "Live history";
    return;
  }
  const closed = held.removable;
  ui.historyCount.textContent =
    `${held.open.toLocaleString()} open ${held.open === 1 ? "sighting" : "sightings"}, `
    + `${closed.toLocaleString()} closed ${closed === 1 ? "record" : "records"}.`;
  ui.historySummary.textContent = `Live history (${held.total.toLocaleString()})`;
}

function disarmHistory() {
  historyArmed = null;
  if (!ui.clearHistory) return;
  ui.clearHistory.textContent = "Clear history";
  ui.cancelClearHistory.hidden = true;
  ui.historyNote.textContent = "";
}

// What the second click will actually do, said in full before it is offered.
function armHistory() {
  const before = historyCutoff(ui.historyAge.value);
  if (before === null || !state.live) return;
  const found = prunableSightings(state.live, { before });
  if (!found.removable) {
    historyArmed = null;
    // Two different empty results, and saying the wrong one is a false
    // statement about the store: "all sightings are open" was printed whenever
    // nothing was old enough, including with 138 closed records sitting in the
    // log. Which one it is depends on whether anything is closed at all, not on
    // whether anything is closed *and* old enough.
    const closed = prunableSightings(state.live, { before: Infinity }).removable;
    ui.historyNote.textContent = closed
      ? `Nothing to remove at that age. ${closed.toLocaleString()} closed `
        + `${closed === 1 ? "record is" : "records are"} held, all of them closed more recently than that.`
      : found.open
        ? `Nothing to remove. All ${found.open.toLocaleString()} sightings are still open, and an open `
          + "sighting is current state rather than history."
        : "Nothing to remove.";
    return;
  }
  // **The count is armed with the cutoff**, because the confirmation names a
  // number and the number is what a pilot agreed to.
  //
  // With an aged cutoff the instant alone is enough: `before` is absolute and fixed at
  // arming, so a window closed after it falls outside. "All" is `Infinity`, which
  // catches whatever arrived in the meantime - so a sync landing between the arming
  // click and the confirming click removes records that were never counted, never
  // described, never in the kind breakdown, and never in the export the note tells you
  // to take first.
  historyArmed = { before, removable: found.removable };
  const label = ui.historyAge.value === "all"
    ? "every closed record"
    : `closed over ${HISTORY_AGES[ui.historyAge.value] ?? "that long"} ago`;
  const span = found.oldest && found.newest && found.oldest !== found.newest
    ? ` They were closed between ${new Date(found.oldest).toLocaleDateString()} and `
      + `${new Date(found.newest).toLocaleDateString()}.`
    : found.newest ? ` It was closed on ${new Date(found.newest).toLocaleDateString()}.` : "";
  const kinds = [...found.kinds].sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count.toLocaleString()} ${kind}`).join(", ");
  ui.historyNote.textContent =
    `This will permanently remove ${found.removable.toLocaleString()} `
    + `${found.removable === 1 ? "record" : "records"} - ${label}.${span}`
    + (kinds ? ` They are ${kinds}.` : "")
    + ` ${found.open.toLocaleString()} open ${found.open === 1 ? "sighting is" : "sightings are"} kept, `
    + "so nothing currently held is affected. This cannot be undone."
    + (historyExportedAt
      ? ` A copy was exported at ${new Date(historyExportedAt).toLocaleTimeString()}; this page cannot`
        + " check that the file was kept."
      : " Nothing has been exported this session - use Export first if you want a copy.");
  ui.clearHistory.textContent = `Remove ${found.removable.toLocaleString()}`;
  ui.cancelClearHistory.hidden = false;
}

// What the confirmation is currently armed on, or null. Exported so a test can
// assert the arm was *cleared* rather than left holding a cutoff for a store
// that has since been replaced - which `armHistory`'s early return makes
// possible and which the DOM cannot show.
function historyCutoffArmed() {
  return historyArmed === null ? null : historyArmed.before;
}

function clearHistory() {
  if (historyArmed === null) {
    armHistory();
    return;
  }
  // **Still the same store?** If the log moved while the confirmation was on
  // screen, the number the pilot agreed to is not the number that would go.
  // Re-arming rather than proceeding keeps their intent - they still want to
  // clear - without removing more than they were shown, and without silently
  // discarding the click.
  //
  // This is the rule `result-state.js` applies to a route: a displayed result
  // belongs to the inputs it was computed from, and when they change it is
  // stale rather than merely old.
  const now = prunableSightings(state.live, { before: historyArmed.before });
  if (now.removable !== historyArmed.removable) {
    const was = historyArmed.removable;
    // `armHistory` owns the arm in both directions - it sets it when there is
    // something to remove and clears it when there is not - so it is not cleared
    // here. A line doing that as well was written, was redundant, and no
    // mutation could tell it from its absence.
    armHistory();
    ui.historyNote.textContent =
      `The history changed while that was on screen - ${was.toLocaleString()} `
      + `${was === 1 ? "record" : "records"} when it was counted, `
      + `${now.removable.toLocaleString()} now. Nothing was removed. ` + ui.historyNote.textContent;
    return;
  }
  const done = pruneSightings(state.live, { before: historyArmed.before });
  disarmHistory();
  persistLive();
  refreshBridges();
  renderAvoidList();
  renderSovereigntyStatus();
  renderAmbientStatus();
  renderCampaignStatus();
  refreshScout();
  renderOverlay();
  refreshOpenInspector();
  renderHistoryCount();
  ui.historyNote.textContent = done.removed
    ? `Removed ${done.removed.toLocaleString()} closed ${done.removed === 1 ? "record" : "records"}. `
      + `${done.kept.toLocaleString()} remain.`
    : "Nothing was removed.";
}

// The history out as a file, so clearing it is recoverable rather than only
// deliberate.
//
// Everything closed, not only what the current age would remove: a pilot taking
// a copy wants the copy, not the part they were about to delete.
//
// `historyExportedAt` records that an export was *triggered*, which is not the
// same as knowing the file was kept. A browser hands the download to the
// operating system and is told nothing further - it can be cancelled, blocked,
// or written somewhere that is cleared tonight. The confirmation says which of
// those two things is true rather than implying the stronger one.
let historyExportedAt = null;

function exportHistory() {
  ui.historyNote.textContent = "";
  const held = state.live ? prunableSightings(state.live, { before: Infinity }) : null;
  if (!held?.removable) {
    ui.historyNote.textContent = "There is no closed history to export.";
    return false;
  }
  const blob = new Blob([historyFile(state.live)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `new-eden-atlas-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  historyExportedAt = Date.now();
  ui.historyNote.textContent =
    `Exported ${held.removable.toLocaleString()} closed ${held.removable === 1 ? "record" : "records"}. `
    + "Import brings them back.";
  return true;
}

// And back in. Only closed windows are ever exported or imported, so a file can
// never assert that something is held now.
async function importHistoryFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  ui.historyNote.textContent = "";
  disarmHistory();
  try {
    const incoming = parseHistoryFile(await file.text());
    const merged = mergeHistory(state.live, incoming);
    persistLive();
    refreshBridges();
    renderSovereigntyStatus();
    renderHistoryCount();
    refreshOpenInspector();
    // A conflict is its own sentence. It is not "already held" - it is a record
    // that disagrees with something this pilot is still watching, which is the
    // half worth reading.
    const clash = merged.conflicted
      ? ` ${merged.conflicted.toLocaleString()} ${merged.conflicted === 1 ? "record" : "records"} `
        + `disagreed with sightings still open here and ${merged.conflicted === 1 ? "was" : "were"} not imported.`
      : "";
    ui.historyNote.textContent = (merged.added
      ? `Restored ${merged.added.toLocaleString()} ${merged.added === 1 ? "record" : "records"}`
        + (merged.skipped ? `, ${merged.skipped.toLocaleString()} already held.` : ".")
      : merged.skipped
        ? `Nothing new: all ${merged.skipped.toLocaleString()} records were already held.`
        : "Nothing was imported.") + clash;
  } catch (error) {
    ui.historyNote.textContent = `History import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
}

// --- the character vault ----------------------------------------------------------
//
// Shell only. The panel stays hidden in a browser, and hidden means absent -
// not a disabled button with an explanation. A sign-in control a page cannot
// honour invites a pilot to look for their credentials in the one place this
// project has decided they must never be, and "it is greyed out" is a weaker
// answer than "there is nothing here".
//
// Nothing in this file ever sees a token. `token_begin` runs the whole sign-in
// inside the core and returns only what is shown below: who was added, what
// they were granted, and when it last worked.
function bindVault() {
  if (!ui.vaultPanel) return;
  if (!coreStore()) {
    ui.vaultPanel.hidden = true;
    return;
  }
  ui.vaultPanel.hidden = false;
  ui.vaultAdd.onclick = addCharacter;
  refreshVault();
}

function refreshVault() {
  const invoke = coreStore();
  if (!invoke) return;
  callCore("token.characters")
    .then(entries => {
      // A reply that is not a list is a malformed answer, not an empty vault.
      // Coercing it to [] here would render "No characters yet." for a core
      // that answered with something unrecognisable - the same mistake as
      // reading a corrupt file as an empty one, one layer up.
      if (!Array.isArray(entries)) {
        throw new Error("the core answered with something that is not a character list");
      }
      renderVault(entries);
    })
    .catch(error => {
      // A vault that cannot be read is reported, never rendered empty. An empty
      // list says "no characters", which is a different answer and a wrong one.
      //
      // Saying it is not enough: the panel ships with "No characters yet." in
      // the markup, so an error written beside it left that sentence on screen
      // underneath. The count has to be replaced, not merely accompanied.
      if (ui.vaultCount) ui.vaultCount.textContent = "The character list could not be read.";
      if (ui.vaultList) ui.vaultList.innerHTML = "";
      if (ui.vaultError) ui.vaultError.textContent = `The character list could not be read: ${reason(error)}`;
    });
}

function renderVault(entries) {
  if (!ui.vaultList) return;
  ui.vaultCount.textContent = entries.length
    ? `${entries.length} character${entries.length === 1 ? "" : "s"}.`
    : "No characters yet.";
  ui.vaultList.innerHTML = entries.map(entry => {
    // Character names come from CCP rather than from a player, and are escaped
    // anyway: text arriving from a server is data, and a rule with an exception
    // for trustworthy sources is not a rule.
    const scopes = entry.scopes?.length
      ? `${entry.scopes.length} scope${entry.scopes.length === 1 ? "" : "s"}`
      : "no scopes";
    // "Added", not "synced". Nothing refreshes a token yet - `refresh_tokens`
    // exists and has no caller - so this timestamp is when the character signed
    // in, and describing it as a confirmed refresh would be the application
    // claiming to know something it has never checked.
    //
    // And zero is absent, not 1970. `last_refresh_at` is `#[serde(default)]`
    // and the core falls back to 0 on an unreadable clock; feeding that to the
    // age formatter renders "synced 20716d ago", which is a fact-shaped thing
    // with no fact behind it.
    const stamp = Number(entry.last_refresh_at);
    const health = entry.last_refresh_error
      ? `<span class="corridor-stale">${esc(String(entry.last_refresh_error).slice(0, 80))}</span>`
      : Number.isFinite(stamp) && stamp > 0
        ? esc(liveTimeText("age", stamp * 1000, { embedded: true, verb: "added" }))
        : "added at an unknown time";
    // The established row shape: `corridor-open` is the left cell of a
    // `1fr 26px` grid and stacks its children, `corridor-drop` is the button.
    //
    // The established row shape, whose classes the stylesheet actually defines:
    // `corridor-open` is the left cell and the drop button is the 26px column beside
    // it. A row emitting its own class names is laid out as though it had none, which
    // looks sparse rather than broken.
    //
    // The portrait is a placeholder until the core answers. It carries the
    // character id so `fillPortraits` can find it, and it is `alt=""` because
    // the name is already the next line - a screen reader announcing the
    // character twice is worse than one that does not mention the picture.
    return `<div class="corridor-row">`
      + `<span class="corridor-open">`
      + `<img class="vault-portrait" data-portrait="${esc(String(entry.character_id))}" alt="" `
      + `width="64" height="64">`
      + `<strong>${esc(entry.name ?? "Unnamed")}</strong>`
      + `<span>${esc(scopes)} \u00b7 ${health}</span></span>`
      + `<button class="corridor-drop" type="button" data-forget="${esc(String(entry.character_id))}"`
      + ` data-forget-name="${esc(entry.name ?? "")}"`
      + ` title="Remove this character, its stored credential and its portrait"`
      + ` aria-label="Forget ${esc(entry.name ?? "this character")}">\u2715</button></div>`;
  }).join("");
  for (const button of ui.vaultList.querySelectorAll("[data-forget]")) {
    button.onclick = () => forgetCharacter(
      button.getAttribute("data-forget"),
      button.getAttribute("data-forget-name"),
    );
  }
  fillPortraits();
}

// Pictures arrive after the names, never before them.
//
// The list is rendered and readable first, and each portrait replaces its own
// placeholder whenever the core answers - from a cached file immediately, or
// from CCP's image server the first time. A character with no portrait, a CDN
// that does not answer, and a machine with no network all produce the same
// thing: a row with a blank frame where the picture would be. None of them is
// reported, because none of them is something a pilot would do anything about.
function fillPortraits() {
  const invoke = coreStore();
  if (!invoke || !ui.vaultList) return;
  for (const image of ui.vaultList.querySelectorAll("[data-portrait]")) {
    const id = Number(image.getAttribute("data-portrait"));
    if (!Number.isFinite(id) || id <= 0) continue;
    callCore("portrait.get", { characterId: id })
      .then(uri => {
        // Still the same row? A forget or a re-render between the request and
        // the answer must not paint a face into a list that has moved on.
        if (typeof uri === "string" && uri.startsWith("data:image/") && image.isConnected) {
          image.src = uri;
        }
      })
      .catch(error => {
        // A rejected command and an absent picture are different things, and
        // swallowing both together is how a broken portrait path looks exactly
        // like a character who has no portrait.
        //
        // `null` above is "no picture", which is not worth a word. Landing
        // here means the core refused the request - an unregistered command, a
        // bad argument, a panic - and that is a fault in the application rather
        // than a fact about the character.
        if (ui.vaultError && !ui.vaultError.textContent) {
          ui.vaultError.textContent = `Portraits are unavailable: ${reason(error).slice(0, 160)}`;
        }
      });
  }
}

function addCharacter() {
  const invoke = coreStore();
  if (!invoke) return;
  ui.vaultError.textContent = "";
  ui.vaultAdd.disabled = true;
  ui.vaultAdd.textContent = "Waiting for your browser";
  callCore("token.begin")
    .then(entry => {
      ui.vaultCount.textContent = `${entry?.name ?? "A character"} added.`;
      refreshVault();
    })
    .catch(error => {
      // Shown in full. Every failure this can produce is actionable by the
      // pilot - an unregistered application, a refused consent, a sign-in left
      // too long - and a generic message sends them to the wrong one.
      ui.vaultError.textContent = reason(error);
    })
    .finally(() => {
      ui.vaultAdd.disabled = false;
      ui.vaultAdd.textContent = "Add a character";
    });
}

function forgetCharacter(id, name = "") {
  const invoke = coreStore();
  if (!invoke || !id) return;

  // One click must never be enough, and the question has to say what goes.
  //
  // This asked before, and it asked wrongly: `if (ask && !ask(...))` meant that
  // when `window.confirm` was missing, `ask` was null, the whole condition was
  // false, and the removal went ahead unasked. A guard that opens when its own
  // mechanism is absent is not a guard - and the mechanism it depends on is a
  // webview feature, not something this code controls.
  //
  // So it fails closed. No way to ask means nothing is removed, and the panel
  // says so rather than leaving a button that appears to do nothing.
  const ask = typeof window !== "undefined" && typeof window.confirm === "function"
    ? window.confirm.bind(window)
    : null;
  if (!ask) {
    ui.vaultError.textContent =
      "This character was not removed, because there is no way to ask you to confirm it first. "
      + "Removing a character deletes a credential and cannot be undone from here.";
    return;
  }

  // Named, and itemised. The history shelf already works this way for the same
  // reason: a count alone is not informed consent, and neither is "this
  // character" when a pilot has several and the rows look alike.
  const who = String(name || "").trim() || "This character";
  if (!ask(
    `${who} will be removed.\n\n`
    + "\u2022 the character disappears from this list\n"
    + "\u2022 its refresh token is deleted from this computer's credential store\n"
    + "\u2022 its cached portrait is deleted\n\n"
    + "Nothing here can undo this. Signing in again is the only way back."
  )) {
    return;
  }

  callCore("token.forget", { characterId: Number(id) })
    .then(refreshVault)
    .catch(error => { ui.vaultError.textContent = `The character could not be removed: ${reason(error)}`; });
}

function bindHistory() {
  if (!ui.clearHistory) return;
  ui.clearHistory.onclick = clearHistory;
  ui.cancelClearHistory.onclick = disarmHistory;
  if (ui.exportHistory) ui.exportHistory.onclick = exportHistory;
  // The glyph opens the picker; the hidden input does the reading. Same shape
  // as the corridor shelf, so the two rows behave identically.
  if (ui.importHistory) ui.importHistory.onclick = () => ui.historyFileInput?.click();
  if (ui.historyFileInput) ui.historyFileInput.onchange = importHistoryFile;
  // Changing what would be removed retracts a confirmation that described
  // something else.
  ui.historyAge.addEventListener("change", disarmHistory);
  renderHistoryCount();
}

function persistLive() {
  // The shelf counts what the store holds, so it is refreshed here rather than
  // here rather than at the call sites that happen to be remembered. Refreshed on
  // load, import and clear but not after a sync, a shelf left open through a sync goes
  // on showing the previous figures - and the confirmation, which counts at the moment
  // it is armed, then disagrees with the line directly above it: two numbers for one
  // store, one of them stale, and no way to tell from the screen which.
  //
  // Every sync passes through here, and so will the next layer anyone adds.
  renderHistoryCount();
  // Bridges are sightings: observations with a source and a validity window.
  // Overrides are the pilot's own judgements rather than observations, so they
  // keep their own shape. Both are live data, and neither touches the archive.
  // Whether it actually saved. Local storage refuses when it is full or when
  // the browser is in a mode that forbids it, and writeJson reports that by
  // returning false. Ignored, a sync would look like it worked, the tool would
  // behave correctly all session, and the next launch would say "never synced"
  // with nothing to explain why.
  // Refused rather than attempted. Writing here would replace a save this
  // build could not read with the empty store it fell back to.
  if (state.liveSchemaMismatch !== null && state.liveSchemaMismatch !== undefined) {
    state.persistFailed = true;
    if (ui.persistError) {
      ui.persistError.textContent =
        `Saved live data is version ${state.liveSchemaMismatch} and this page reads version ${LIVE_SCHEMA}. `
        + "It has been left untouched and nothing is being saved this session. Reload to pick up a newer viewer.";
    }
    return;
  }
  // A file we could not read is never written over, for the whole session.
  if (liveWriteRefused) return;
  // The gate. Before the first read resolves the in-memory store is empty by
  // construction, so writing it would replace a good file with nothing. This is
  // a refusal rather than a delay: the change is dropped, not queued.
  if (!liveLoadSettled) {
    // Dropped, not deferred - so it is not "pending" either. Those are the two
    // outcomes the gate exists to distinguish, and one flag for both leaves it stuck
    // on "not yet saved" for ever about data that was thrown away.
    return;
  }
  const payload = {
    schema: LIVE_SCHEMA,
    sightings: sightingsToJSON(state.live),
    sov: state.sovMeta,
    overrides: overridesToJSON(state.overrides),
    ambient: state.ambientMeta,
    activity: state.activityMeta,
    activitySeries: activityToJSON(state.activity),
    campaigns: state.campaignMeta,
    scout: state.scoutMeta,
  };
  const invoke = coreStore();
  if (invoke) {
    // Coalesced. persistLive fires on every override toggle, every sync, every
    // import and every clear, and a thirty-character store serialises to 25 MB
    // - writing that on each click is how a map starts feeling broken. The
    // window close flushes, so nothing is lost to the debounce.
    //
    // In flight is not saved. `persistPending` stays true until the core
    // answers, so nothing downstream can read a not-yet-written store as a
    // written one.
    state.persistPending = true;
    const run = () => callCore("sightings.save", { store: payload })
      .then(() => {
        state.persistFailed = false;
        // Cleared on success, which the browser path already does and this one
        // did not. One transient failure - a momentarily locked file, a disk
        // that fills and is emptied - otherwise told the pilot nothing was
        // being saved for the rest of the session while everything was. The
        // browser path carries a comment saying this exact bug was found and
        // fixed there once.
        if (ui.persistError) ui.persistError.textContent = "";
      })
      .catch(error => {
        state.persistFailed = true;
        if (ui.persistError) {
          ui.persistError.textContent =
            `Live data could not be saved. The previous save is untouched. (${reason(error).slice(0, 120)})`;
        }
      })
      .finally(() => { state.persistPending = false; });
    // Recorded before it is scheduled, and cleared by identity. Writing
    // `pendingCoreWrite = { timer: setTimeout(...) }` reads naturally and is
    // wrong: a timer that fires during the call - which a synchronous
    // scheduler does - runs the callback before the assignment completes, so
    // the callback's `pendingCoreWrite = null` is immediately overwritten by a
    // stale handle that nothing will ever clear.
    if (pendingCoreWrite) clearTimeout(pendingCoreWrite.timer);
    const entry = { run, timer: null };
    pendingCoreWrite = entry;
    entry.timer = setTimeout(() => {
      if (pendingCoreWrite === entry) pendingCoreWrite = null;
      run();
    }, CORE_WRITE_DELAY_MS);
    return;
  }
  state.persistFailed = !writeJson(localStorage, LIVE_KEY, payload);
  // Its own line, not the shared one. Sharing meant a layer failure could
  // overwrite it - telling the pilot "the rest is current" while nothing at all
  // was being written - and that a recovered save left the warning on screen
  // because nothing ever cleared it.
  if (ui.persistError) {
    // Why it failed, not only that it did.
    //
    // The sighting log only grows - closures are kept, because a disappearance
    // is itself the intelligence - and local storage has a hard quota of a few
    // megabytes. At roughly 200 bytes an observation that is somewhere around
    // twenty-five thousand of them, after which nothing is ever saved again.
    // "Live data could not be saved locally" is true and sends the pilot to
    // look at their disk; the actual cause is a history that has outgrown the
    // place it is kept, and only the count says so.
    let detail = "";
    if (state.persistFailed) {
      const observations = state.live?.observations?.length ?? 0;
      let size = 0;
      try {
        size = JSON.stringify(payload).length;
      } catch {
        size = 0;
      }
      detail = size
        ? ` The live history holds ${observations.toLocaleString()} observations and needs `
          + `${(size / 1048576).toFixed(1)} MB, which is more than this browser will store.`
        : "";
    }
    ui.persistError.textContent = state.persistFailed
      ? `Live data could not be saved locally. It will be lost when this page closes.${detail}`
      : "";
  }
}

// --- activity ------------------------------------------------------------------
//
// Where people are dying and where they are travelling. Public, hourly, and the
// overlay people open DOTLAN for more than any other.
//
// Kept as a bounded series rather than in the sighting log, for the reason set
// out in activity.js: a kill count is a measurement over a window, not an
// object with a lifetime, and it never goes away to be closed with a date.
function activityKnown() {
  return Boolean(state.activityMeta?.dataAt) && Boolean(state.activity?.latest);
}

// Kills specifically, which is not the same question. The two endpoints fail
// independently, and `dataAt` gets set from whichever half answered - so a
// successful jumps sync next to a 503 on kills left activityKnown() true and
// every kill figure on screen reading zero. Weighing a route on that, or
// telling a pilot nobody died, is the failure this distinguishes.
function killsKnown() {
  if (!activityKnown()) return false;
  const latest = state.activity.latest;
  // A reading exists if this sync measured one, or an earlier one did and we
  // are still carrying it. Only "never answered" is unknown.
  return latest.killsMeasured !== false || latest.killsAt !== null;
}

// Measured in the most recent sync, as opposed to carried forward from an
// earlier one. Both are honest; only one is current.
function killsFresh() {
  return activityKnown() && state.activity.latest.killsMeasured !== false;
}

function renderActivityStatus() {
  if (!ui.activityAge) return;
  if (!activityKnown()) {
    ui.activityAge.textContent = "activity: never synced";
    ui.activityAge.classList.remove("stale");
  } else {
    const hot = hottest(state.activity, 1)[0];
    const samples = sampleCount(state.activity);
    // "quiet" is a measurement and must not be printed over an endpoint that
    // did not answer. The kills half can fail while the jumps half succeeds,
    // and the bar then reported a quiet universe on the strength of a 503.
    const worst = !killsKnown()
      ? "kills unavailable"
      : hot ? `${state.atlas?.systems?.[hot.systemId]?.name ?? hot.systemId} ${hot.playerKills}` : "quiet";
    // When the kills half did not answer, the counts on screen are the previous
    // reading and the age shown must be theirs, not the jumps half's. Showing
    // the sample's age would dress a six-hour-old count as current.
    const carried = killsKnown() && !killsFresh();
    const shownAt = (killsFresh() ? state.activityMeta?.dataAt : state.activity.latest.killsAt)
      ?? state.activityMeta?.dataAt;
    ui.activityAge.textContent = `activity: ${worst}${carried ? " (carried)" : ""} \u00b7 ${samples}h \u00b7 ${liveTimeText("age", shownAt, { embedded: true })}`;
    ui.activityAge.classList.toggle("stale", isDue(state.activityMeta) || carried);
  }
}

async function syncActivityLayer({ fetchImpl = null } = {}) {
  if (state.activitySyncing) return { ok: false, reason: "busy" };
  state.activitySyncing = true;
  try {
    if (!state.activity) state.activity = createActivity();
    const outcome = await syncActivity(state.activity, { cached: state.activityMeta, fetchImpl });
    if (!outcome.ok) return { ok: false, reason: outcome.kills?.reason ?? "unknown" };
    const at = outcome.sample?.at ?? null;
    state.activityMeta = {
      kills: { etag: outcome.kills.etag, expiresAt: outcome.kills.expiresAt, dataAt: outcome.kills.dataAt },
      jumps: { etag: outcome.jumps.etag, expiresAt: outcome.jumps.expiresAt, dataAt: outcome.jumps.dataAt },
      dataAt: at,
      // The sooner of the two, so the layer asks again as soon as either half
      // has something new rather than waiting for the slower one - and null
      // when neither stated one, rather than Infinity.
      //
      // Math.min of two Infinities is Infinity, which is truthy, so nextPollAt
      // returned it instead of falling back to the conservative hour. isDue was
      // then false forever and the layer could never read as stale again. The
      // fallback exists for exactly this case - esi.js says a missing header
      // must not freeze a layer - and constructing an Infinity walked around
      // it. The ambient layer twenty lines below already does this correctly.
      expiresAt: (() => {
        const stated = [outcome.kills.expiresAt, outcome.jumps.expiresAt].filter(Number.isFinite);
        return stated.length ? Math.min(...stated) : null;
      })(),
      fetchedAt: Date.now(),
    };
    persistLive();
    refreshOpenInspector();
    // A route weighed against the last hour's kills is wrong the moment this
    // hour's arrive, and it says so out loud: the panel kept reporting "no
    // player kill on this route" beside a bar that had just updated to show
    // fifteen. Only recalculate when the weighting is actually being applied -
    // otherwise the numbers changed but the answer cannot have.
    if (state.route && buildHeat().applied) calculateRoute();
    return { ok: true, partial: !outcome.killsState.ok || !outcome.jumpsState.ok };
  } finally {
    state.activitySyncing = false;
    renderActivityStatus();
  }
}

// What the inspector is told. Null when nothing has been synced, because a
// measured zero and an unmeasured one are different claims.
function heatIn(systemId) {
  if (!activityKnown()) return null;
  const entry = heatOf(state.activity, systemId);
  if (!entry) return null;
  return {
    ...entry,
    playerKills: playerKillsIn(state.activity, systemId),
    text: describeHeat(entry),
    trend: trendOf(state.activity, systemId),
  };
}

// --- sovereignty campaigns -----------------------------------------------------
//
// What is being fought over, where, and when. Public, and cached for five
// seconds rather than an hour - CCP expects this polled during a fight, which
// tells you what it is for.
//
// A campaign has a real lifetime: announced, run, ended. So it lives in the
// sighting log, and a campaign that ends is closed with a date - what was
// contested last week is exactly the kind of record this store exists to keep.
function campaignsKnown() {
  return Boolean(state.campaignMeta?.dataAt);
}

function renderCampaignStatus() {
  if (!ui.campaignAge) return;
  if (!campaignsKnown()) {
    ui.campaignAge.textContent = "timers: never synced";
    ui.campaignAge.classList.remove("stale");
    return;
  }
  const live = liveNow(state.live).length;
  const soon = upcoming(state.live).length;
  // Live and upcoming are counted apart because they are different problems:
  // one is a fight to join, the other a fight to plan for.
  ui.campaignAge.textContent = `timers: ${live} live \u00b7 ${soon} in 24h \u00b7 ${liveTimeText("age", state.campaignMeta?.dataAt, { embedded: true })}`;
  ui.campaignAge.classList.toggle("stale", isDue(state.campaignMeta));
}

async function syncCampaignLayer({ fetchImpl = null } = {}) {
  const outcome = await syncCampaigns(state.live, { cached: state.campaignMeta, fetchImpl });
  if (!outcome.ok) {
    state.campaignMeta = markSyncFailed(state.campaignMeta, outcome.result?.reason);
    // Saved, or the mark lasts until the tab closes: the stored meta keeps its
    // `dataAt` and loses `failed`, so the next launch reads a layer that has
    // not been refreshed since as synced.
    persistLive();
    renderCampaignStatus();
    return { ok: false, reason: outcome.result?.reason ?? "unknown" };
  }
  state.campaignMeta = {
    ...clearSyncFailure(state.campaignMeta),
    etag: outcome.result.etag,
    expiresAt: outcome.result.expiresAt,
    dataAt: outcome.result.dataAt ?? state.campaignMeta?.dataAt ?? outcome.result.fetchedAt,
    fetchedAt: outcome.result.fetchedAt,
  };
  persistLive();
  renderCampaignStatus();
  refreshOpenInspector();
  return { ok: true };
}

// What the inspector is told. Null when nothing has been synced: an unasked
// question and a quiet system are different answers, and for a timer the
// difference is the whole point.
function campaignsFor(systemId) {
  if (!campaignsKnown()) return null;
  const now = Date.now();
  return campaignsIn(state.live, systemId)
    .map(campaign => ({
      ...campaign,
      text: describeCampaign(campaign, now),
      label: eventLabel(campaign.event_type),
      live: campaign.startTime !== null && campaign.startTime <= now,
    }));
}

// Marked on the map. A live timer and a scheduled one are drawn differently
// because a fleet commander reads them differently.
function markCampaigns(){
  if(!campaignsKnown()||state.mode!=="region")return;
  const now=Date.now(),bySystem=campaignSystems(state.live);
  for(const node of state.nodes){
    const here=bySystem.get(node.record.system_id);
    if(!here?.length)continue;
    node.el.classList.add(here.some(c=>c.startTime!==null&&c.startTime<=now)?"timer-live":"timer-soon")
  }
}

// --- Thera and Turnur ----------------------------------------------------------
//
// The one third-party service, and the only layer that is off unless asked for.
// A wormhole expires, collapses on mass and refuses hulls above its size; none
// of those are things to route a pilot through because a tool could.
function scoutEnabled() {
  return Boolean(ui.scoutEnabled?.checked);
}

function scoutKnown() {
  return Boolean(state.scoutMeta?.dataAt);
}

// Whether a system is on the stargate graph. A hole into J-space is a scanning
// target, not a shortcut, and this is exactly the property that decides.
function onGateGraph(systemId) {
  return (state.atlas?.systems?.[String(systemId)]?.neighbors?.length ?? 0) > 0;
}

function scoutSignatures(now = Date.now()) {
  if (!state.live) return [];
  // A hull that does not resolve gates nothing through, rather than everything.
  // The only way to get here unresolved is to ask for the active ship without a
  // character, and offering holes a freighter cannot fit is the failure that
  // strands somebody.
  const hull = resolveHull(ui.scoutHull?.value, { activeShipClass: state.activeShipClass ?? null });
  if (!hull) return [];
  return routableSignatures(state.live, { connected: onGateGraph, hullClass: hull, now });
}

// Rebuilt whenever the answer could have changed: a sync, the toggle, the hull.
// Off, or never synced, and there is no network at all rather than an empty one
// that looks like a considered answer.
// **A route across a hole is only good while that hole is still reported**, and
// this is the one place that can know it has stopped being reported.
//
// **The recalculation happens here, where the set changes**, rather than in one of the
// callers. `syncScoutLayer`, the toggle, the hull and the tick all reach this function,
// so a check in any one of them is a check three other paths skip - and a check in the
// tick cannot fire at all, because `syncScoutLayer` has already moved the count.
//
// What that costs: EVE-Scout stops listing a hole on the route, the sighting is
// correctly closed, the sync reports `ok: true`, and the panel keeps reading "Mixed
// route - 1 jump - wormhole" for a pair whose real answer is eleven gate jumps. It
// never self-corrects, and `ROUTE_FIELDS` cannot catch it because the signature set is
// not an input a pilot typed. A route planned on a closed record sends a pilot through
// structures that are no longer there.
//
// Keyed on what a route actually depends on, not on how many holes there are.
// A count is blind to one hole dying as another opens, which is the ordinary
// case for a service that scans continuously.
function scoutFingerprint(usable) {
  return usable
    .map(signature => `${signature.outSystemId}>${signature.inSystemId}@${signature.expiresAt}:${signature.maxShipSize}`)
    .sort()
    .join("|");
}

function refreshScout(now = Date.now()) {
  const usable = scoutEnabled() && scoutKnown() ? scoutSignatures(now) : [];
  const fingerprint = scoutFingerprint(usable);
  const moved = fingerprint !== state.scoutFingerprint;
  state.scoutFingerprint = fingerprint;
  state.scoutNet = state.routePlanner && usable.length
    ? scoutNetwork(state.routePlanner, usable)
    : null;
  renderScoutStatus();
  renderScoutList(usable, now);
  // Only a route that crosses one is affected, and recalculating is cheap
  // beside showing a leg that is no longer there.
  if (moved && state.route?.wormholeJumps) calculateRoute();
}

function renderScoutStatus() {
  if (!ui.scoutBar) return;
  ui.scoutBar.hidden = !scoutEnabled();
  if (!scoutEnabled()) return;
  ui.scoutAge.textContent = scoutKnown()
    ? `holes: ${state.scoutNet?.count ?? 0} usable \u00b7 ${liveTimeText("age", state.scoutMeta?.dataAt, { embedded: true })}`
    : "holes: never synced";
  ui.scoutAge.classList.toggle("stale", scoutKnown() && isDue(state.scoutMeta));
}

function renderScoutList(usable = null, now = Date.now()) {
  if (!ui.scoutList) return;
  const all = scoutKnown() && state.live ? openSignatures(state.live, now) : [];
  // The hubs the scanners actually scanned from, not a list written down here.
  const hubs = scoutHubs(all);
  const routable = new Set((usable ?? scoutSignatures(now)).map(signature => signature.id));
  ui.scoutSummary.innerHTML = scoutSummaryMarkup(routable.size, scoutEnabled());
  ui.scoutList.innerHTML = scoutRows(all.map(signature => ({
    id: signature.id,
    text: describeSignature(signature),
    expiresAt: signature.expiresAt,
    // Why a connection cannot be used, rather than leaving it off the list. A
    // hole that is there but unusable is a fact worth having.
    unusable: routable.has(signature.id) ? null
      : !scoutEnabled() ? "wormhole routing off"
        : !resolveHull(ui.scoutHull?.value, { activeShipClass: state.activeShipClass ?? null }) ? "choose a hull size"
        : !scoutEndpoint(signature.inSystemId, onGateGraph, hubs) || !scoutEndpoint(signature.outSystemId, onGateGraph, hubs) ? "outside the supported routing network"
        : `too small for a ${ui.scoutHull?.value ?? "hull"}`,
  })), scoutKnown());
}

async function syncScoutLayer({ fetchImpl = null } = {}) {
  // Not fetched at all unless asked for. A third-party service should not be
  // called by a tool the pilot has not opted into using.
  if (!scoutEnabled()) return { ok: true, skipped: true };
  ui.scoutError.textContent = "";
  const outcome = await syncScout(state.live, { cached: state.scoutMeta, fetchImpl });
  if (!outcome.ok) {
    state.scoutMeta = markSyncFailed(state.scoutMeta, outcome.result?.reason);
    persistLive();
    // Three outcomes, not two. A refused answer is not a missing one: the
    // service replied and this build would not hold what it sent, and "did not
    // answer" sends a pilot to check their network for a fault that is here.
    ui.scoutError.textContent = outcome.result?.reason === "offline"
      ? "EVE-Scout is unreachable. Showing what was last scanned."
      : outcome.result?.reason === "malformed"
        ? "EVE-Scout answered with something this build will not hold. Showing what was last scanned."
        : "EVE-Scout did not answer. Showing what was last scanned.";
    refreshScout();
    return { ok: false, reason: outcome.result?.reason ?? "unknown" };
  }
  state.scoutMeta = {
    // Through `clearSyncFailure` rather than by building a fresh object and
    // happening to omit the mark. The next edit that spreads the old meta
    // forward would otherwise keep a layer failed after it recovered.
    ...clearSyncFailure(state.scoutMeta),
    etag: outcome.result.etag,
    expiresAt: outcome.result.expiresAt,
    dataAt: outcome.result.dataAt ?? outcome.result.fetchedAt,
    fetchedAt: outcome.result.fetchedAt,
  };
  persistLive();
  refreshScout();
  refreshOpenInspector();
  return { ok: true };
}

function bindScout() {
  ui.scoutEnabled.addEventListener("change", () => {
    saveRouteSettings();
    // Turning it on with nothing scanned yet should fetch, not sit blank.
    if (scoutEnabled() && !scoutKnown()) inBackground(syncScoutLayer, "The wormhole sync");
    else { refreshScout(); if (state.route) calculateRoute(); }
  });
  ui.scoutHull.addEventListener("change", () => {
    saveRouteSettings();
    refreshScout();
    if (state.route) calculateRoute();
  });
}

// What the router is handed: the alliance's own bridges, plus scanned holes
// when they have been asked for. Both are one-jump undirected edges; only the
// reporting tells them apart.
function routingNetwork() {
  // Expiry must be checked at calculation time, even between display ticks.
  refreshScout();
  if (!state.bridges && !state.scoutNet) return undefined;
  return mergeBridges(state.bridges ?? undefined, state.scoutNet ?? undefined);
}

// --- one control for every live layer ----------------------------------------------
//
// Three layers, three cadences, one button. Separate buttons asked the pilot to
// know which endpoint carries which fact, which is this tool's problem and not
// theirs - and left three ways to have two-thirds of a current map.
// The floor between one press of Sync and the next actually reaching a server.
//
// There is no polling loop in this application - the only timer refreshes
// displayed ages and never issues a request - so every call to ESI is a person
// pressing a button. That is not the automated circumvention CCP's docs warn
// about, and gating it on each endpoint's Expires would make the button lie:
// most windows are an hour, and a pilot who has waited and wants to look again
// should be able to.
//
// A held-down button is a different thing, and it is the one real way this
// application can hammer a public service. Five seconds is ESI's own shortest
// cache window (sovereignty campaigns), so below it there is nothing new to
// fetch by the server's own account. Refused out loud, with when it will work,
// because a button that quietly does nothing reads as a broken button.
export const MIN_SYNC_INTERVAL_MS = 5_000;

// A task nobody awaits, and the one place a throw from one can still be seen.
//
// Every layer sync uses `try/finally` - for its busy flag and the button's own
// reset - and none of them catch. That is right: a failure belongs in the layer's
// error slot, and each of them puts it there. What none of them handle is a throw,
// from a renderer or a parse or `persistLive`, and where the caller awaits there is
// somebody to notice. Where nothing awaits, the rejection went nowhere: no message,
// no slot, and a map that silently did not update.
//
// This does not swallow it. The live error slot is where a pilot already looks when
// a sync misbehaves, and the console keeps the stack for whoever has to fix it.
function inBackground(task, what) {
  Promise.resolve().then(task).catch(error => {
    if (ui.liveError) {
      ui.liveError.textContent = `${what} failed unexpectedly. The map and routing are unaffected.`;
    }
    console.error(what, error);
  });
}

async function syncLive({ fetchImpl = null } = {}) {
  if (state.liveSyncing) return;
  state.liveSyncing = true;
  ui.liveError.textContent = "";
  ui.liveSync.disabled = true;
  ui.liveSync.textContent = "Syncing";
  try {
    const [, , activity, campaigns, scout] = await Promise.all([
      syncSov({ fetchImpl }),
      syncAmbient({ fetchImpl }),
      syncActivityLayer({ fetchImpl }),
      syncCampaignLayer({ fetchImpl }),
      syncScoutLayer({ fetchImpl }),
    ]);
    // Each layer already says its own piece in its own slot. This says only
    // what none of them can: that the whole thing failed, which is the case a
    // pilot reads as "the tool is broken" rather than "one endpoint is down".
    const layers = [sovereigntyKnown(), ambientKnown(), activityKnown(), campaignsKnown()];
    const down = layers.filter(known => !known).length;
    if (down === layers.length) {
      ui.liveError.textContent = "No live layer could be reached. The map and routing are unaffected.";
    } else {
      const failed = [
        activity && !activity.ok && activity.reason !== "busy" ? "Activity" : null,
        campaigns && !campaigns.ok ? "Timers" : null,
        scout && !scout.ok && !scout.skipped ? "Wormholes" : null,
      ].filter(Boolean);
      // A half-failed activity sync returns ok, because the half that answered
      // is worth keeping. Saying nothing about it was how a dead kills endpoint
      // became "the rest is current" over a map reading zero kills everywhere.
      const partial = activity?.ok && activity.partial && !killsFresh() ? "Kill counts" : null;
      const notes = [...failed, partial].filter(Boolean);
      if (notes.length) {
        // "The rest is current" was a claim this line is not in a position to
        // make. Sovereignty and ambient are awaited above and their results are
        // discarded, so neither can ever appear in `notes` - and when the
        // network is down every layer fails, `down === layers.length` is false
        // because those counters mean "ever synced", and the bar read
        // "Activity and Timers and Wormholes did not sync. The rest is
        // current." with the sovereignty slot two lines below saying it was
        // showing what was last synced.
        //
        // Each layer already states its own age in its own slot. This line says
        // which ones failed and stops there.
        ui.liveError.textContent =
          `${notes.join(" and ")} did not sync. Every layer is shown with its own age.`;
      }
    }
  } finally {
    state.liveSyncing = false;
    ui.liveSync.disabled = false;
    ui.liveSync.textContent = "Sync";
    renderOverlay();
    if (state.mode === "region" && state.region) renderRegion(state.selected);
  }
}

// The floor belongs on the button, not on syncLive, because the button is the
// only thing a person can hold down. syncLive itself stays a plain function
// that does what it is told - which is also what lets the suite drive it.
function liveSyncAllowed(now = Date.now(), lastAt = state.lastLiveSyncAt) {
  const since = now - (lastAt ?? -Infinity);
  return since >= MIN_SYNC_INTERVAL_MS ? null : Math.max(1, Math.round(since / 1000));
}

function bindLive() {
  ui.liveSync.onclick = () => {
    const held = liveSyncAllowed();
    if (held !== null) {
      ui.liveError.textContent =
        `Synced ${held}s ago. Nothing on ESI republishes faster than that.`;
      return;
    }
    state.lastLiveSyncAt = Date.now();
    inBackground(syncLive, "The live sync");
  };
}

// --- ambient state -----------------------------------------------------------
//
// Incursions and faction-warfare frontlines. Neither changes who owns space;
// both change whether it is safe to cross, which is the question this map is
// for. Both endpoints are public, and the pair is synced together because they
// answer the same question and neither is worth a button of its own.
//
// The roadmap's third ambient layer, Triglavian and EDENCOM system status, is
// absent because no ESI endpoint carries it. Reported as missing rather than
// guessed at.
function ambientKnown() {
  return Boolean(state.ambientMeta?.dataAt);
}

function renderAmbientStatus() {
  if (!ui.ambientBar) return;
  if (!ambientKnown()) {
    ui.ambientAge.textContent = "ambient: never synced";
    ui.ambientAge.classList.remove("stale");
  } else {
    const incursions = new Set([...incursionSystems(state.live).values()].map(entry => entry.constellation_id));
    const contested = contestedFrontlines(state.live).length;
    ui.ambientAge.textContent = `ambient: ${incursions.size} incursion${incursions.size === 1 ? "" : "s"} \u00b7 `
      + `${contested} contested \u00b7 ${liveTimeText("age", state.ambientMeta?.dataAt, { embedded: true })}`;
    ui.ambientAge.classList.toggle("stale", isDue(state.ambientMeta));
  }
  ui.ambientSync.disabled = state.ambientSyncing;
  ui.ambientSync.textContent = state.ambientSyncing ? "Syncing" : "Sync";
}

async function syncAmbient({ fetchImpl = null } = {}) {
  if (state.ambientSyncing) return;
  state.ambientSyncing = true;
  ui.ambientError.textContent = "";
  renderAmbientStatus();
  try {
    // Both, and independently: one endpoint being down is no reason to throw
    // away the other's answer. A partial sync is still worth more than none,
    // and the failure is reported rather than hidden behind the success.
    const [incursions, frontlines] = await Promise.all([
      syncIncursions(state.live, { cached: state.ambientMeta?.incursions ?? null, fetchImpl }),
      syncFactionWarfare(state.live, { cached: state.ambientMeta?.frontlines ?? null, fetchImpl }),
    ]);
    const failures = [["Incursions", incursions], ["Frontlines", frontlines]].filter(([, o]) => !o.ok);
    if (failures.length === 2) {
      // Mark both, then return. Returning before the meta assignment below leaves a
      // *total* ambient failure marking neither half while a partial one marks
      // correctly - the worse outcome being the silent one, which is the wrong way
      // round for a rule about absence.
      state.ambientMeta = {
        ...(state.ambientMeta ?? {}),
        incursions: markSyncFailed(state.ambientMeta?.incursions, incursions.result?.reason),
        frontlines: markSyncFailed(state.ambientMeta?.frontlines, frontlines.result?.reason),
      };
      persistLive();
      ui.ambientError.textContent = failures[0][1].result?.reason === "offline"
        ? "Ambient state is unavailable offline. Showing what was last synced."
        : "Ambient sync failed. Showing what was last synced.";
      return;
    }
    if (failures.length === 1) {
      ui.ambientError.textContent = `${failures[0][0]} did not sync. The rest is current.`;
    }
    const meta = part => ({
      etag: part.result.etag,
      expiresAt: part.result.expiresAt,
      dataAt: part.result.dataAt ?? part.result.fetchedAt,
      fetchedAt: part.result.fetchedAt,
    });
    // The half that did not sync keeps the meta it had, and that retained meta
    // still counts towards the age. Taking the minimum over only the halves
    // that succeeded would report "synced just now" while half the overlay was
    // an hour stale - which is the exact failure the age exists to prevent.
    const parts = {
      // Per half, because they fail independently - which is exactly why the
      // snapshot names them apart rather than collapsing both into "ambient".
      incursions: incursions.ok
        ? clearSyncFailure(meta(incursions))
        : markSyncFailed(state.ambientMeta?.incursions, incursions.result?.reason),
      frontlines: frontlines.ok
        ? clearSyncFailure(meta(frontlines))
        : markSyncFailed(state.ambientMeta?.frontlines, frontlines.result?.reason),
    };
    const oldest = field => {
      const values = Object.values(parts).map(part => part?.[field]).filter(Number.isFinite);
      return values.length ? Math.min(...values) : null;
    };
    state.ambientMeta = { ...parts, dataAt: oldest("dataAt"), expiresAt: oldest("expiresAt") };
    persistLive();
    renderOverlay();
    refreshOpenInspector();
    if (state.mode === "region" && state.region) renderRegion(state.selected);
  } finally {
    state.ambientSyncing = false;
    renderAmbientStatus();
  }
}

function bindAmbient() {
  // Through `inBackground`, like the other three: this layer uses `try/finally`
  // for its busy flag and does not catch, so a throw from a renderer had nowhere
  // to go from a click handler.
  ui.ambientSync.onclick = () => inBackground(syncAmbient, "The incursion sync");
}

// What the inspector is told about one system. Null when nothing has ever been
// synced, for the same reason sovereignty draws that line: an absent overlay
// and a quiet one are different statements.
function ambientOf(systemId) {
  if (!ambientKnown() || !state.live) return null;
  const incursion = incursionSystems(state.live).get(Number(systemId)) ?? null;
  const frontline = frontlineSystems(state.live).get(Number(systemId)) ?? null;
  return {
    incursion,
    frontline,
    incursionText: describeIncursion(incursion, state.atlas),
    frontlineText: describeFrontline(frontline, state.atlas),
    at: state.ambientMeta?.dataAt ?? null,
  };
}

// --- jump bridges ------------------------------------------------------------
//
// Recorded as sightings, under the store law: each is an observation with a
// source and a window, so a bridge that goes away is closed with a date rather
// than deleted - its disappearance is the intelligence. Today the only source
// is the pilot typing it in. When the per-corporation structures read exists it
// writes the same records with a character as the source and nothing
// downstream changes.
//
// Only an alliance's own bridges can be used at all since the change to
// Ansiblex access, so there is nothing here to pull about anyone else's.
const BRIDGE_KIND = "bridge";
const MANUAL_SOURCE = "manual";

// Whose bridges the router is allowed to use.
//
// One character's access, never the union - a route planned against every
// token's bridges sends a pilot through structures they cannot dock at or jump
// from. There is one source today, so this returns a constant; the point is
// that the router asks for a source at all, so adding a second token is a
// change to this function rather than a silent widening of every route.
// --- the two laws the token layer is not allowed to renegotiate ------------------
//
// They are written together because they fail together. Both are about refusing
// to answer a question with something that merely looks like an answer, and the
// token layer is the first thing that will be tempted to break either.
//
//   1. ROUTING MUST PASS ONE SOURCE.
//      A route is planned against the travelling character's own bridges and
//      standings - never the union of every token, and never a closed record.
//      Data from other characters is display-only intelligence. A union-routed
//      plan sends a pilot through structures they cannot use.
//
//      This is structural rather than remembered: the router is never handed
//      the union, so it cannot use it by accident. `bridgeEntries(source)`
//      takes one; `bridgeEntries()` takes all and goes only to the panel.
//
//   2. A FAILED SYNC REPORTS NOTHING. IT DOES NOT REPORT THAT THE WORLD EMPTIED.
//      Per source. A dead refresh token and a demolished citadel look identical
//      to a sync - in both cases the thing did not come back - and treating them
//      alike writes absence of observation into the log as observation of
//      absence, closed with a date that will never be right again.
//
//      The store already refuses the public-endpoint version of this:
//      `recognisedNothing` catches a payload that arrived with rows and parsed
//      to nothing, because that is schema drift rather than an empty universe.
//      Thirty tokens will eventually include one that expires quietly, and
//      inheriting this per character is what stops that wiping a spy's
//      structures and writing a fake retreat into the permanent record.
//
// When the character selector arrives it changes the function directly below
// and nothing else. Do not "prepare" the router for many characters - it is
// already prepared, by refusing the union.
// The travelling character, and the reason this is a function rather than a
// field read: it is the single place a selector plugs in, and it is where the
// "one source, never the union" law has to hold.
//
// Nothing but a usable single source may leave here. A selector with nobody
// chosen yet yields `undefined`, and `undefined` handed to `bridgeEntries`
// means *every* source - measured, not assumed: a store holding one bridge from
// Alice and one from Bob returns both for `undefined` exactly as it does for
// `null`. The router would then plan against every character's bridges and
// produce a route that looks entirely ordinary while sending a pilot through
// structures they cannot use.
//
// `state.travelCharacter` is the field a selector will set. Until one exists it
// stays null and this is the manual source, which is what every bridge is
// currently recorded against.
function routingSource() {
  const chosen = state.travelCharacter;
  return typeof chosen === "string" && chosen !== "" ? chosen : MANUAL_SOURCE;
}

// `source` null means every source, which is display-only intelligence: the
// list shows what is known, and says who saw it. Routing must pass one.
function bridgeEntries(source = null) {
  return openObservations(state.live, BRIDGE_KIND, { source })
    .map(entry => ({ ...entry.value, key: entry.key, source: entry.source, since: entry.firstSeen }))
    .filter(entry => entry.from && entry.to);
}

// What the router may use, as opposed to what the panel may show.
//
// `bridgeEntries` defaults to *every* source, because that is what the display
// wants - and that makes the dangerous value the default one. Hand it an
// `undefined` and it returns the union, indistinguishably from asking for the
// union on purpose: a store holding one bridge from Alice and one from Bob returns
// both for `null` and both for `undefined`.
//
// `routingSource()` returns a constant today, so nothing reaches that - and it is the
// single function a travelling-character selector replaces, where a selector with
// nobody chosen yet naturally yields `undefined`. At that point the router silently
// plans against every character's bridges: an ordinary-looking route through
// structures the pilot cannot use.
//
// So the router asks through here, and a missing source yields **no** bridges rather
// than all of them. That is the safe direction - a route with no bridges is a longer
// route through gates, and a route with somebody else's bridges is a pilot stranded in
// a structure that will not let them in.
function routableBridges(source) {
  if (typeof source !== "string" || source === "") return [];
  return bridgeEntries(source);
}

// The network handed to the router. Resolved once per change rather than once
// per route, and only from open sightings: a closed bridge is history, and
// history is never a routing edge.
function refreshBridges() {
  // Two lists on purpose. The panel shows everything known, because a bridge
  // another character reported is intelligence worth seeing; the router gets
  // only the travelling character's own, because using the rest would plan a
  // route through structures this pilot cannot use.
  const shown = bridgeEntries();
  const mine = routableBridges(routingSource());
  state.bridges = state.routePlanner ? state.routePlanner.resolveBridges(mine) : null;
  renderBridges(shown);
}

function addBridge(fromValue, toValue) {
  if (!ui.bridgeError) return;
  ui.bridgeError.textContent = "";
  if (!state.routePlanner) {
    ui.bridgeError.textContent = "The archive is still loading.";
    return;
  }
  try {
    // strict, so a typo is refused at the point of entry rather than recorded
    // as a bridge that silently never applies to a route.
    state.routePlanner.resolveBridges([{ from: fromValue, to: toValue }], { strict: true });
    // Resolved the same way the router resolves them, which accepts an id as
    // well as a name. Resolving by name only here refused a bridge the strict
    // check had just accepted, and did it with a TypeError's message.
    const ends = [fromValue, toValue].map(value => state.routePlanner.resolveBridgeEnd(value));
    // Stored in the order the key uses. The key is undirected, so the same
    // physical bridge typed from the other end reaches the same record - and
    // without this, its value differs, which the sighting store correctly reads
    // as the bridge having changed. It would close a window and open a new one
    // over a bridge that never moved, writing a retreat into the record.
    const [from, to] = ends[0].system_id < ends[1].system_id ? ends : [ends[1], ends[0]];
    observe(state.live, {
      kind: BRIDGE_KIND,
      key: edgeKey(from.system_id, to.system_id),
      value: { from: from.system_id, to: to.system_id, fromName: from.name, toName: to.name },
      source: MANUAL_SOURCE,
    });
    persistLive();
    refreshBridges();
    ui.bridgeFrom.value = "";
    ui.bridgeTo.value = "";
    // A route already on screen was found without this bridge, so it is now
    // stale rather than wrong. Recalculating is what the pilot asked for by
    // adding the bridge.
    if (state.route) calculateRoute();
  } catch (error) {
    ui.bridgeError.textContent = error.message;
  }
}

function dropBridge(key, source = "manual") {
  // Closed, not deleted: a bridge that is gone means a retreat or a fuel
  // crisis, and the history has to survive the removal.
  //
  // **Whose row**, because the log holds one per source. Unsourced, this closed
  // whatever the id-only index pointed at: with a second observer's row present it
  // either did nothing or closed theirs, and a pilot pressing Remove twice on a
  // bridge that would not go away is the visible half of that.
  closeSighting(state.live, BRIDGE_KIND, key, source);
  persistLive();
  refreshBridges();
  if (state.route) calculateRoute();
}

function renderBridges(entries = bridgeEntries()) {
  if (!ui.bridgeList) return;
  ui.bridgeSummary.innerHTML = bridgeSummaryMarkup(entries.length);
  ui.bridgeList.innerHTML = bridgeRows(entries);
  ui.bridgeList.querySelectorAll("[data-drop-bridge]")
    .forEach(button => {
      button.onclick = () => dropBridge(button.dataset.dropBridge, button.dataset.dropSource);
    });
}

// --- the avoidance list --------------------------------------------------------
//
// One screen for everything being avoided, whichever mechanism put it there:
// standing orders from the override store, which outlive any single route and
// expire on their own, and this route's typed entries, which travel with the
// corridor. Keeping them on one screen is the point - the failure worth
// preventing is avoiding something in one list and being routed through it by
// the other.
function avoidListEntries() {
  pruneOverrides(state.overrides);
  // Ignored entries only. `confirmed` is the inverse - the pilot saying they
  // just flew it and it was fine - and listing one as "routed around" would
  // report the opposite of what they said.
  const standing = listOverrides(state.overrides).filter(entry => entry.state === "ignored").map(entry => ({
    ...entry,
    scope: "standing",
    label: overrideLabel(entry),
  }));
  const routeScoped = [
    ...avoidEntries(ui.avoidSystems?.value).map(label => ({ scope: "route", kind: "system", label })),
    ...avoidEntries(ui.avoidRegions?.value).map(label => ({ scope: "route", kind: "region", label })),
  ];
  return [...standing, ...routeScoped];
}

// One switch over the whole list, both scopes. The list is one list, so a
// toggle that suspended only the standing orders and left the typed fields
// biting would be the same disagreement the list exists to prevent - and the
// pilot would have turned avoidance "off" and still been routed around
// something.
//
// Off suspends rather than clears. The entries keep their timers, so turning it
// back on restores exactly what was there rather than an empty list.
function avoidanceApplied() {
  return state.avoidOn !== false;
}

// What the router is actually handed. An empty store rather than the real one,
// so nothing downstream has to know about the switch.
function appliedOverrides() {
  // Never `null`. `state.overrides` is null until `restoreLive()` fills it, and
  // a null store is a *present* argument to `calculate` and an *absent* one to
  // `freezeRouting` - so a brief taken before the live store loaded froze an
  // incomplete record and refused every route, for the same reason and with the
  // same wrong sentence as the bridges above.
  if (!avoidanceApplied()) return createOverrides();
  return state.overrides ?? createOverrides();
}

function setAvoidance(on) {
  state.avoidOn = Boolean(on);
  ui.avoidToggle.setAttribute("aria-pressed", String(state.avoidOn));
  ui.avoidToggle.textContent = state.avoidOn ? "Avoidance on" : "Avoidance off";
  ui.avoidToggle.classList.toggle("off", !state.avoidOn);
  refreshAvoid();
  saveRouteSettings();
  if (state.route) calculateRoute();
}

function bindAvoidToggle() {
  ui.avoidToggle.onclick = () => setAvoidance(!avoidanceApplied());
}

function renderAvoidList() {
  if (!ui.ignoreList) return;
  const entries = avoidListEntries();
  ui.ignoreSummary.innerHTML = ignoreSummaryMarkup(entries.length, avoidanceApplied());
  ui.ignoreList.innerHTML = ignoreRows(entries, avoidanceApplied());
  ui.ignoreList.querySelectorAll("[data-restore]").forEach(button => {
    const [target, key] = button.dataset.restore.split("|");
    button.onclick = () => {
      clearOverride(state.overrides, target, key);
      persistLive();
      renderAvoidList();
      if (state.route) calculateRoute();
      renderOverlay();
    };
  });
  ui.ignoreList.querySelectorAll("[data-unavoid]").forEach(button => {
    const divider = button.dataset.unavoid.indexOf("|");
    const kind = button.dataset.unavoid.slice(0, divider);
    const label = button.dataset.unavoid.slice(divider + 1);
    button.onclick = () => {
      const input = kind === "region" ? ui.avoidRegions : ui.avoidSystems;
      input.value = avoidEntries(input.value)
        .filter(entry => entry.toLowerCase() !== label.toLowerCase()).join(", ");
      refreshAvoid();
      saveRouteSettings();
      if (state.route) calculateRoute();
    };
  });
}

// A key is an id or an edge; neither reads as anything on its own.
function overrideLabel(entry) {
  if (entry.target === "system") return state.atlas?.systems?.[entry.key]?.name ?? `System ${entry.key}`;
  if (entry.target === "region") return state.atlas?.regions?.[entry.key]?.name ?? `Region ${entry.key}`;
  const [from, to] = String(entry.key).split("-")
    .map(id => state.atlas?.systems?.[id]?.name ?? id);
  return `${from} \u2014 ${to}`;
}

// Avoid a system for a while, from the map rather than by typing its name. A
// standing order, so it survives this route and every corridor loaded after it.
function ignoreSystem(systemId, { duration = "day", strength = null, reason = "" } = {}) {
  setOverride(state.overrides, { target: "system", key: systemId, duration, strength, reason });
  persistLive();
  renderAvoidList();
  if (state.route) calculateRoute();
  renderOverlay();
}

function bindBridges() {
  const add = () => addBridge(ui.bridgeFrom.value, ui.bridgeTo.value);
  $("addBridge").onclick = add;
  for (const input of [ui.bridgeFrom, ui.bridgeTo]) {
    input.addEventListener("keydown", event => { if (event.key === "Enter") add(); });
  }
}

// Never synced and nothing held are different states and must read differently.
// An unsynced store draws no sovereignty at all, and saying "no sovereignty"
// for it would present an empty universe as a finding.
function sovereigntyKnown() {
  return Boolean(state.sovMeta?.dataAt);
}

function renderSovereigntyStatus() {
  if (!ui.sovBar) return;
  const age = sovereigntyKnown() ? dataAge(state.sovMeta) : null;
  const held = sovereigntyKnown() ? (state.sovHeld?.size ?? heldSystems(state.live).size) : null;
  ui.sovAge.textContent = held === null
    ? "sov: never synced"
    : `sov: ${held.toLocaleString()} held \u00b7 ${liveTimeText("age", state.sovMeta?.dataAt, { embedded: true })}`;
  // Past its expiry is worth showing rather than silently serving old data.
  ui.sovAge.classList.toggle("stale", sovereigntyKnown() && isDue(state.sovMeta));
  ui.sovSync.disabled = state.syncing;
  ui.sovSync.textContent = state.syncing ? "Syncing" : "Sync";
  // The same form the panel rendered. This tick fires every thirty seconds, so
  // writing the bare phrase here would have quietly un-capitalised the sentence
  // half a minute after the inspector opened.
  tickLiveTimes();
}

// fetchImpl is injectable so this is reachable without a network, which the
// suite requires and which is also how the offline and malformed-response
// paths get exercised at all.
async function syncSov({ fetchImpl = null } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  ui.sovError.textContent = "";
  renderSovereigntyStatus();
  try {
    const outcome = await syncSovereignty(state.live, { cached: state.sovMeta, fetchImpl });
    if (!outcome.ok) {
      // A failed sync keeps whatever was known and says what went wrong. It
      // must never look like a map with no sovereignty in it - and the mark
      // goes on the meta as well as on screen, because a snapshot reads state.
      state.sovMeta = markSyncFailed(state.sovMeta, outcome.result?.reason);
      persistLive();
      ui.sovError.textContent = outcome.result?.reason === "offline"
        ? "Sovereignty is unavailable offline. Showing what was last synced."
        : `Sovereignty sync failed (${outcome.result?.reason ?? "unknown"}). Showing what was last synced.`;
      return;
    }
    state.sovMeta = {
      ...clearSyncFailure(state.sovMeta),
      etag: outcome.result.etag,
      expiresAt: outcome.result.expiresAt,
      dataAt: outcome.result.dataAt ?? state.sovMeta?.dataAt ?? outcome.result.fetchedAt,
      fetchedAt: outcome.result.fetchedAt,
    };
    state.sovHeld = heldSystems(state.live);
    persistLive();
    refreshOpenInspector();
    if (state.mode === "region" && state.region) renderRegion(state.selected);
  } finally {
    state.syncing = false;
    renderSovereigntyStatus();
  }
}

function bindSovereignty({ schedule = typeof window === "undefined" ? null : window.setInterval.bind(window) } = {}) {
  restoreLive();
  // Assigned through `inBackground` rather than directly: a handler that *is* an
  // async function returns a promise to the DOM, which discards it.
  ui.sovSync.onclick = () => inBackground(syncSov, "The sovereignty sync");
  // Refresh displayed ages only; this timer never issues an ESI request.
  if (schedule && sovAgeTimer === null) {
    sovAgeTimer = schedule(renderLiveAges, 30_000);
    document.addEventListener("visibilitychange", renderLiveAges);
  }
}

// The holder of a system, or null when nothing is known - which the caller must
// distinguish from nobody holding it.
function sovHolderOf(systemId) {
  if (!sovereigntyKnown() || !state.live) return null;
  return holderOf(state.live, systemId);
}

function renderConstellations(){
  ui.constellations.innerHTML = constellationButtons(Object.values(state.region.constellations));
  ui.constellations.querySelectorAll("button")
    .forEach(b => { b.onclick = () => filterConstellation(b.dataset.c); });
}
function filterConstellation(id){
  state.constellation=id;
  ui.constellations.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b.dataset.c===id));
  ui.viewport.querySelectorAll("[data-c]").forEach(n=>n.classList.toggle("dimmed",id!=="all"&&n.dataset.c!==id));
  ui.viewport.querySelectorAll(".edge[data-a]").forEach(n=>n.classList.toggle("dimmed",id!=="all"&&n.dataset.a!==id&&n.dataset.b!==id));
  syncFixedMapElements()
}
function selectSystem(id){
  const s=state.region.systems[id];
  if(!s)return;
  state.selected=id;
  ui.tacticalSystem.value=s.name;
  state.nodes.forEach(n=>n.el.classList.toggle("selected",n.record.system_id===id));
  syncFixedMapElements();
  showSystem(s)
}
// **The door says what it drew.** `state.selected` survives every panel change,
// and `refreshOpenInspector` was built on it alone - so a sync redrew a *system*
// inspector over whatever was actually on screen. A pilot mid-route-plan pressed
// Sync and their route analysis was replaced by a panel about a system they had
// clicked minutes earlier, while the route stayed drawn on the map: the map and
// the inspector disagreeing about what is being looked at.
//
// Eight callers reach `refreshOpenInspector`, including every sync and the
// thirty-second tick, so the guard belongs here rather than in each of them.
// `kind` is required - a caller that forgets it gets `undefined`, which is not
// "system", which means the inspector is left alone. Failing closed is right:
// the cost of not refreshing is a stale age, and the cost of refreshing wrongly
// is a panel about the wrong thing.
function display(html, kind){
  state.panel = kind ?? null;
  // **The brief's snapshot belongs to the brief, and this is where the brief
  // stops being on screen.**
  //
  // The opener is appended to `ui.content`, and every panel in the application
  // is rendered by overwriting `ui.content`. So selecting a system after taking
  // a brief wiped the opener while `state.briefSnapshot` stayed set - and the
  // next thing to call `renderAskOpener`, which the availability check does
  // when it resolves, appended "Ask about this brief" to a *system* panel.
  // A button about a brief that is no longer there, offering to fork a snapshot
  // of it.
  //
  // Cleared here and set again by `showTacticalBrief` **after** its `display`,
  // so the snapshot exists exactly while the briefing it was taken from is
  // what a pilot is looking at.
  state.briefSnapshot = null;
  // And the read is unbound from the render in the same breath. It is a
  // sentence about one set of findings, and a panel that is no longer those
  // findings has no business holding it.
  //
  // **Unbound, not forgotten.** `key` and `text` stay, so rebuilding the same
  // brief shows the same sentence instead of buying a fresh turn - see the
  // budget note on `requestPanelRead`. Nothing is re-rendered here because
  // `ui.content` is overwritten two lines below anyway.
  state.panelRead = { ...state.panelRead, forSnapshot: null };
  ui.empty.hidden=true;
  ui.content.hidden=false;
  ui.content.innerHTML=html;
  if(typeof window!=="undefined"&&window.matchMedia("(max-width: 760px)").matches){
    ui.rail.classList.remove("open");
    ui.toolsToggle.setAttribute("aria-expanded","false");
    ui.toolsToggle.setAttribute("aria-label","Open navigation and planning tools")
  }
  ui.inspector.classList.add("open")
}
function showRegion(r){
  const systems = r.systems.map(id => state.atlas.systems[id]).filter(Boolean);
  const adjacent = new Set();
  for (const jump of state.atlas.jumps) {
    if (jump.from_region_id === r.region_id && jump.to_region_id !== r.region_id) adjacent.add(jump.to_region_id);
    if (jump.to_region_id === r.region_id && jump.from_region_id !== r.region_id) adjacent.add(jump.from_region_id);
  }
  const facts = {
    adjacentRegionIds: [...adjacent],
    meanSecurity: systems.length ? systems.reduce((sum, s) => sum + s.security, 0) / systems.length : 0,
  };
  display(regionPanel(r, facts, id => state.atlas.regions[id]?.name, state.mode === "universe"), "region");
  ui.content.querySelectorAll("[data-region]")
    .forEach(b => { b.onclick = () => loadRegion(state.atlas.regions[b.dataset.region].name); });
  ui.content.querySelector("[data-open]")?.addEventListener("click", () => loadRegion(r.name));
}
function showSystem(s){
  const constellation = state.region.constellations[s.constellation_id];
  const neighbors = s.neighbors.map(id => state.atlas.systems[id]).filter(Boolean);
  const holding = sovHolderOf(s.system_id);
  display(systemPanel(s, {
    sovereignty: sovereigntyKnown()
      ? {
        holding,
        colour: holding ? allianceColour(holding.alliance_id) : null,
        at: state.sovMeta?.dataAt ?? null,
      }
      : null,
    constellationName: constellation?.name || "Unknown",
    regionName: state.region.region.name,
    neighbors,
    regionNameFor: id => state.atlas.regions[id].name,
    securityColour: secColor,
    securityName: secName,
    // What a path count is read against. Computed once per archive and cached
    // on it: a figure with no scale is not information, and this one spreads
    // across three orders of magnitude.
    graphScale: graphScale(state.atlas),
    avoided: standingAvoidance(s.system_id),
    threats: threatsToSystem(s.system_id),
    ambient: ambientOf(s.system_id),
    campaigns: campaignsFor(s.system_id),
    heat: heatIn(s.system_id),
  }), "system");
  ui.content.querySelectorAll("[data-system]").forEach(b => {
    b.onclick = () => {
      const id = +b.dataset.system;
      state.region.systems[id] ? selectSystem(id) : loadRegion(b.dataset.regionName, id);
    };
  });
  ui.content.querySelectorAll("[data-threat-from]").forEach(button => {
    button.onclick = () => {
      const origin = state.atlas.systems[button.dataset.threatFrom];
      if (origin) loadRegion(state.atlas.regions[origin.region_id].name, origin.system_id);
    };
  });
  ui.content.querySelector("[data-avoid-add]")?.addEventListener("click", () => addAvoidSystem(s.name));
  ui.content.querySelector("[data-avoid-standing]")?.addEventListener("click", event => {
    const action = event.currentTarget?.dataset?.avoidStanding
      ?? ui.content.querySelector("[data-avoid-standing]").dataset.avoidStanding;
    if (action === "clear") {
      clearOverride(state.overrides, "system", s.system_id);
      persistLive();
      renderAvoidList();
      if (state.route) calculateRoute();
      renderOverlay()
    } else ignoreSystem(s.system_id, { duration: action });
    showSystem(s)
  });
}

// How long a standing order on this system has left, or null when there is
// none. The panel needs the difference, because offering "avoid" for something
// already avoided says the store is not being read.
function standingAvoidance(systemId) {
  const entry = activeOverride(state.overrides, "system", systemId);
  // Same reason as the list: a confirmed system is not an avoided one, and
  // offering to stop avoiding it would be answering a question nobody asked.
  if (entry?.state !== "ignored") return null;
  // The instant, not the text. The panel renders it and the tick refreshes it,
  // both through the one transform.
  return { expiresAt: entry.expiresAt };
}
function updateSearch(){
  // The field is live before the archive is. Typing into it during the first
  // load read `state.atlas.systems` off null and threw - the search simply
  // stopped working, with a TypeError in the console and nothing on screen.
  // Regions arrive first, so they are searchable while systems are not.
  if (!state.atlas) {
    ui.results.hidden = !ui.search.value.trim();
    if (!ui.results.hidden) ui.results.innerHTML = '<p class="layout-note">Loading the archive.</p>';
    return;
  }
  const all = searchMatches(ui.search.value, {
    regions: state.index,
    systems: Object.values(state.atlas.systems),
    regionNameFor: id => state.atlas.regions[id].name,
    securityOf: system => system.security,
  });
  if (!ui.search.value.trim()) {
    ui.results.hidden = true;
    return;
  }
  ui.results.innerHTML = searchResultsMarkup(all);
  ui.results.hidden = false;
  ui.results.querySelectorAll("button").forEach(button => {
    button.onclick = () => {
      const match = all[+button.dataset.i];
      ui.results.hidden = true;
      ui.search.value = "";
      match.type === "region" ? loadRegion(match.name) : loadRegion(match.region, match.id);
    };
  });
}
function tip(e,t,s){
  ui.tooltip.innerHTML=`${esc(t)}<small>${esc(s)}</small>`;
  ui.tooltip.hidden=false;
  ui.tooltip.style.left=`${e.clientX+13}px`;
  ui.tooltip.style.top=`${e.clientY+13}px`
}
function hideTip(){
  ui.tooltip.hidden=true
}
// A result is shown only while it still matches the inputs that produced it.
// Each panel records the key of its inputs when it succeeds; any change to
// those fields clears the result rather than leaving it looking current.
function threatValues(){
  return{staging:ui.threatStaging?.value ?? ""}
}
function jumpValues(){
  return{
    from: ui.jumpFrom.value,
    to: ui.jumpTo.value,
    ship: ui.jumpShip.value,
    calibration: ui.jumpCalibration.value,
    conservation: ui.jumpConservation.value,
    hullSkill: ui.jumpHullSkill.value,
    fuelModule: ui.jumpFuelModule.value,
    highSec: ui.jumpHighSec.checked
  }
}
function routeValues(){
  return{
    from:ui.routeFrom.value,to:ui.routeTo.value,mode:ui.routeMode.value,
    avoidSystems:ui.avoidSystems.value,avoidRegions:ui.avoidRegions.value,
    minSec:ui.routeMinSec.value,maxSec:ui.routeMaxSec.value,avoidOn:avoidanceApplied(),
    heat:ui.routeHeat?.value??"off",
    scout:String(scoutEnabled()),scoutHull:ui.scoutHull?.value??"medium"
  }
}
function invalidateStaleResults(){
  let changed=false;
  const jump=jumpValues();
  if(state.range&&isStale(state.rangeInputs,keyFor(RANGE_FIELDS,jump))){
    clearRangeRings();
    changed=true
  }
  if(state.jump&&isStale(state.jumpInputs,keyFor(JUMP_FIELDS,jump))){
    clearJumpResult();
    changed=true
  }
  if(state.route&&isStale(state.routeInputs,keyFor(ROUTE_FIELDS,routeValues()))){
    clearRoute();
    changed=true
  }
  if(state.threat&&isStale(state.threatInputs,keyFor(THREAT_FIELDS,threatValues()))){
    // The overlay and the map markings go together, like every other result
    // here - `clearThreat` already does both.
    clearThreat();
    changed=true
  }
  return changed
}
// Dropping a route result: the map overlay and the inspector panel that
// describes it have to go together, or one outlives the other.
function clearRouteResult(){
  state.route=null;
  state.routeIndex=null;
  state.routeInputs=null;
  if(ui.content.querySelector("[data-route-system]")){
    ui.content.hidden=true;
    ui.content.innerHTML="";
    ui.empty.hidden=false
  }
}
function clearJumpResult(){
  state.jump=null;
  state.jumpIndex=null;
  state.jumpInputs=null;
  if(ui.content.querySelector("[data-jump-system]")){
    ui.content.hidden=true;
    ui.content.innerHTML="";
    ui.empty.hidden=false
  }
  renderOverlay();
  legend(state.mode)
}
// What the router is handed to weigh.
//
// `applied` is false whenever there is nothing to weigh - no setting, or no
// activity synced - and the route carries that through to the panel. A route
// found without kill data must never look like one that found no kills, which
// is the same line every live layer here draws.
// Every system name in the archive, lower-cased by `opinion.js` and cached here
// because it is one allocation per archive rather than one per turn - the same
// reason `graphScale` is cached on the atlas it was computed from.
//
// Names, not the archive: `opine` needs to recognise a name and has no business
// holding anything else, and a set of strings cannot be a rule for inventing one.
let systemNameCache = null;
function systemNames(){
  if(!state.atlas)return null;
  if(systemNameCache&&systemNameCache.atlas===state.atlas)return systemNameCache.names;
  const names=Object.values(state.atlas.systems).map(system=>system.name);
  systemNameCache={atlas:state.atlas,names};
  return names
}

function buildHeat(){
  const weight=HEAT_LEVELS[ui.routeHeat?.value]??0;
  // killsKnown, not activityKnown: an unmeasured hour would weigh every system
  // at zero, which is not "no weighting" but "weighted as though it were safe".
  // Three states, named. `killsKnown()` is false for two different reasons, and
  // reporting both as "no activity data has been synced" contradicts the live bar
  // whenever activity synced and only the kills endpoint failed.
  if(!weight)return{...emptyHeat(),weight,unweighed:"off"};
  if(!killsKnown())return{...emptyHeat(),weight,unweighed:activityKnown()?"kills-absent":"never-synced"};
  const kills=new Map();
  for(const[systemId,value]of state.activity.latest.kills){
    const count=(value.shipKills??0)+(value.podKills??0);
    if(count>0)kills.set(systemId,count)
  }
  // The kills' own instant, not the sample's. A route weighed on carried-forward
  // counts must report the age of the counts it was weighed on.
  return{kills,weight,at:(killsFresh()?state.activityMeta?.dataAt:state.activity.latest.killsAt)??null,applied:true}
}
// **Everything the planner is handed, gathered once.**
//
// Seven expressions inline in `calculateRoute` leave only two ways to build a frozen
// routing record: a second reading of the interface, or a second reading of `state` -
// and a second reading is a second answer. The
// "Done when" is that a route from an operation and a route from the button
// agree; `tests/routing-operations.test.mjs` proves the rehydrator from one
// source inward, and this is what lets a test prove the **assembly** as well,
// by handing one object to the planner and to the freeze.
//
// It throws on an avoid name that does not resolve, exactly as before. That is
// the pilot's typo, and the route box is where it belongs - which is also why
// this must not be called on the brief path, where the fault would be
// swallowed into a missing opener.
function plannerInputs(){
  // Guarded rather than assumed. The route box reports an unresolvable avoid name as a
  // sentence, and a planner that has not loaded yet arrives as `Cannot read properties
  // of null`, which is not a sentence anybody can act on. `refreshAvoid` guards the
  // same call.
  if(!state.routePlanner)throw new Error("The map is still loading, so a route cannot be planned yet.");
  const applied=avoidanceApplied();
  // Off means off, including a name in the field that does not resolve. A
  // suspended list must not be able to refuse a route.
  const avoid=applied?state.routePlanner.resolveAvoid(ui.avoidSystems.value,ui.avoidRegions.value):emptyAvoid();
  // What the list is holding back while it is switched off. Carried on the
  // avoid object because a frozen record has to be able to tell a suspended
  // list from an empty one - they route identically and mean the opposite.
  avoid.suspended=applied?0:suspendedAvoidCount();
  return{
    avoid,
    limits:state.routePlanner.resolveLimits(ui.routeMinSec.value,ui.routeMaxSec.value),
    // **Captured, and empty**, rather than absent. `routingNetwork()` answers
    // `undefined` when there is no bridge network and no scout data - which is
    // every default install - and `calculate` reads that as "use your default".
    // `freezeRouting` reads it as *not captured*, sets `complete: false`, and
    // `jumps_between` then refuses every route for every pilot who has recorded
    // no Ansiblex and not enabled EVE-Scout. Two different sentences, and this
    // is the one place that knows which is true: we looked, and there are none.
    //
    // Substituting the empty value anywhere further in would be the opposite
    // mistake - that is the distinction `present()` exists to keep.
    bridges:routingNetwork()??emptyBridges(),
    overrides:appliedOverrides(),
    heat:buildHeat(),
    // The pilot's, never the model's: 11 jumps shortest against 34 high-sec-only.
    mode:ui.routeMode.value,
  };
}

function calculateRoute(){
  ui.routeError.textContent="";
  let inputs;
  try{
    inputs=plannerInputs()
  }catch(error){
    state.avoid=null;
    state.limits=null;
    clearRouteResult();
    updateAvoidSummary();
    renderOverlay();
    legend(state.mode);
    ui.routeError.textContent=error.message;
    return
  }
  const{avoid,limits}=inputs;
  state.avoid=avoid;
  state.limits=limits;
  updateAvoidSummary();
  try{
    // The instant is passed rather than defaulted. `calculate` falls back to
    // `Date.now()`, which is right for a button and leaves the value implicit - so
    // nothing can assert that this path and an operation's agree. Overrides expire and
    // heat is stamped, so the instant is the input that decides whether they still
    // apply.
    state.routeAt=Date.now();
    // **What the button actually used**, kept so a test can freeze that object rather
    // than assembling a second one. A second assembly is a second answer:
    // `calculateRoute` rewrites the route boxes to canonical names between the two
    // calls, `suspendedAvoidCount` re-reads the clock, and any drift this function
    // introduces after the assembly is invisible to a test that re-assembles.
    state.routeInputsUsed=inputs;
    state.route=state.routePlanner.calculate(ui.routeFrom.value,ui.routeTo.value,inputs.mode,inputs.avoid,inputs.limits,
      inputs.bridges,inputs.overrides,inputs.heat,state.routeAt);
    state.jump=null;
    state.jumpIndex=null;
    ui.routeFrom.value=state.route.origin.name;
    ui.routeTo.value=state.route.destination.name;
    // A suspended list is still a standing order, and a route planned without
    // it still broke one - deliberately, but the panel said nothing at all.
    // routeProtestPanel exists because "saying nothing would present a route
    // that breaks a standing order as an ordinary one", and switching the list
    // off produced exactly that: the route crossed an avoided system, no
    // section appeared, and the only trace was a toggle label somewhere else on
    // screen. Counted from the sources rather than the resolved list, because
    // the resolved list is empty by the time the router sees it.
    state.route.avoidanceSuspended=inputs.avoid.suspended;
    state.routeIndex=buildRouteIndex(state.route);
    state.routeInputs=keyFor(ROUTE_FIELDS,routeValues());
    saveRouteSettings();
    renderOverlay();
    legend(state.mode);
    showRoute(state.route)
  }catch(error){
    clearRouteResult();
    renderOverlay();
    legend(state.mode);
    ui.routeError.textContent=error.message
  }
}
const ROUTE_KEY = STORAGE_KEYS.route;
// What a suspended avoidance list is holding back.
//
// There are two sources and the panel has to answer for both: the names typed
// under Route limits, and the persistent entries a pilot adds from a system's
// own panel with "Avoid for a day". Only the typed ones were counted, so a
// pilot who had never typed anything got the case this section exists to
// prevent - a route crossing a system they had asked to avoid, with nothing on
// the panel saying so.
//
// Deduplicated by what an entry resolves to rather than by how it was written:
// a system both typed and set to avoid is one place the route may now cross,
// and calling it two overstates what has been suspended. A typed name that
// resolves to nothing is still counted - the pilot wrote it and it is not being
// applied - and cannot collide with an override, which is keyed by id.
//
// Trust entries are not avoidance and are not counted. Suspending the list does
// suspend them, but a confirmed gate is not somewhere the route is being held
// back from, and counting it would inflate the number with the opposite of the
// thing being reported.
function suspendedAvoidCount(now=Date.now()){
  const suspended=new Set();
  for(const entry of avoidEntries(ui.avoidSystems.value)){
    const system=state.routePlanner?.resolveSystem(entry);
    suspended.add(system?`system:${system.system_id}`:`typed-system:${entry.toLowerCase()}`)
  }
  for(const entry of avoidEntries(ui.avoidRegions.value)){
    const region=state.routePlanner?.resolveRegion(entry);
    suspended.add(region?`region:${region.region_id}`:`typed-region:${entry.toLowerCase()}`)
  }
  for(const entry of listOverrides(state.overrides,now)){
    if(entry.state!=="ignored")continue;
    suspended.add(`${entry.target}:${entry.key}`)
  }
  return suspended.size
}
function avoidEntries(value){
  return String(value||"").split(/[,;]/).map(entry=>entry.trim()).filter(Boolean)
}
function boundEntries(){
  return[ui.routeMinSec.value,ui.routeMaxSec.value].filter(value=>String(value).trim()).length
}
function activeLimitCount(){
  return state.avoid&&state.limits?state.avoid.systemIds.size+state.avoid.regionIds.size+(state.limits.min===null?0:1)+(state.limits.max===null?0:1):null
}
function updateAvoidSummary(){
  const raw = avoidEntries(ui.avoidSystems.value).length + avoidEntries(ui.avoidRegions.value).length + boundEntries();
  ui.limitsSummary.innerHTML = limitsSummaryMarkup(raw, activeLimitCount());
}
function refreshAvoid(){
  try{
    state.avoid=!avoidanceApplied()
      ?emptyAvoid()
      :state.routePlanner?state.routePlanner.resolveAvoid(ui.avoidSystems.value,ui.avoidRegions.value):null;
    state.limits=state.routePlanner?state.routePlanner.resolveLimits(ui.routeMinSec.value,ui.routeMaxSec.value):null
  }catch{
    state.avoid=null;
    state.limits=null
  }
  updateAvoidSummary();
  renderAvoidList();
  renderOverlay();
  if(state.atlas)legend(state.mode)
}
function saveRouteSettings(){
  writeJson(localStorage, ROUTE_KEY, {
    from:ui.routeFrom.value,to:ui.routeTo.value,mode:ui.routeMode.value,
    avoidSystems:ui.avoidSystems.value,avoidRegions:ui.avoidRegions.value,
    minSecurity:ui.routeMinSec.value,maxSecurity:ui.routeMaxSec.value,avoidOn:avoidanceApplied(),
    heat:ui.routeHeat?.value??"off",
    scout:scoutEnabled(),scoutHull:ui.scoutHull?.value??"medium"
  });
}
function restoreRouteSettings(){
  const saved = readJson(localStorage, ROUTE_KEY);
  if (!saved) return;
  ui.routeFrom.value=saved.from||"";
  ui.routeTo.value=saved.to||"";
  // Checked against the modes this build has, like the heat level two lines below and
  // the layout mode in `settings.js`. A stored mode it does not know - a
  // renamed option, a downgrade, a hand edit - goes straight into the control while
  // `calculate()` silently falls back to "shortest", so the panel says one thing, the
  // route is computed under different rules, and nothing reports it. In a real browser
  // the select shows blank instead, which is differently confusing and equally silent.
  //
  // Falling back without a message is right - it is a stale preference, not an error -
  // but the control and the route have to agree about which mode that is.
  if(saved.mode)ui.routeMode.value=ROUTE_MODES.includes(saved.mode)?saved.mode:DEFAULT_ROUTE_MODE;
  ui.avoidSystems.value=saved.avoidSystems||"";
  ui.avoidRegions.value=saved.avoidRegions||"";
  ui.routeMinSec.value=saved.minSecurity||"";
  ui.routeMaxSec.value=saved.maxSecurity||"";
  // Absent in a save written before the switch existed, and absent has to mean
  // on: a stored avoidance list that silently stopped applying after an update
  // would be the worst possible reading of a missing field.
  if(saved.heat&&ui.routeHeat)ui.routeHeat.value=HEAT_LEVELS[saved.heat]===undefined?"off":saved.heat;
  if(ui.scoutEnabled)ui.scoutEnabled.checked=saved.scout===true;
  if(saved.scoutHull&&ui.scoutHull)ui.scoutHull.value=saved.scoutHull;
  setAvoidance(saved.avoidOn !== false);
  if(ui.avoidSystems.value||ui.avoidRegions.value||ui.routeMinSec.value||ui.routeMaxSec.value)ui.limitsPanel.open=true
}
function addAvoidSystem(name){
  const current=avoidEntries(ui.avoidSystems.value);
  if(current.some(entry=>entry.toLowerCase()===String(name).toLowerCase()))return;
  current.push(name);
  ui.avoidSystems.value=current.join(", ");
  ui.limitsPanel.open=true;
  refreshAvoid();
  saveRouteSettings();
  // Every other way of avoiding a system recalculates. This one did not, so a
  // pilot could press "avoid" and watch the line stay drawn through the system
  // they had just excluded - marked forbidden and routed through at once.
  if(state.route)calculateRoute()
}
function pairKey(a,b){
  return a<b?`${a}-${b}`:`${b}-${a}`
}
function buildRouteIndex(route){
  if(!route?.systems?.length)return null;
  const order=new Map(),regionOrder=[];
  route.systems.forEach((system,step)=>{if(!order.has(system.system_id))order.set(system.system_id,step);if(regionOrder.at(-1)!==system.region_id)regionOrder.push(system.region_id)});
  return{
    order,regionOrder,regionIds:new Set(regionOrder),originId:(route.origin??route.systems[0]).system_id,destinationId:(route.destination??route.systems.at(-1)).system_id
  }
}
function routeSegment(layer,shape,attributes){
  layer.append(S(shape,{...attributes,class:"route-halo"}));
  layer.append(S(shape,{...attributes,class:"route-line"}))
}
function routeBadge(layer,x,y,label,endpoint,offsetX=0,offsetY=0){
  const badge=pinMapElement(S("g",{class:"route-badge-group"}),x,y,offsetX,offsetY);
  badge.append(S("circle",{cx:0,cy:0,r:8.5,class:`route-badge${endpoint?" endpoint":""}`}));
  badge.append(S("text",{x:0,y:3.2,class:"route-badge-text"},label));
  layer.append(badge)
}
function styleGateEdges(){
  ui.viewport.querySelectorAll(".gate-edge-halo").forEach(node=>node.remove());
  if(state.mode!=="region"||!state.region||!state.positions)return;
  const jumps=state.region.jumps.filter(jump=>state.region.systems[jump.from_system_id]&&state.region.systems[jump.to_system_id]),byKey=new Map();
  for(const path of ui.viewport.querySelectorAll(".edge")){
    const key=path.getAttribute("data-jump");
    if(key)byKey.set(key,path)
  }
  const analysis=assignCrossingChannels(jumps,jump=>[state.positions.get(state.region.systems[jump.from_system_id]),state.positions.get(state.region.systems[jump.to_system_id])]);
  jumps.forEach(jump=>{const path=byKey.get(`${jump.from_system_id}-${jump.to_system_id}`),channel=analysis.channels.get(jump)??0;if(!path)return;for(let old=0;old<8;old+=1)path.classList.remove(`gate-edge-${old}`);path.classList.add("gate-edge",`gate-edge-${channel}`);path.setAttribute("data-edge-channel",String(channel));const lane=readLane(path),halo=S("path",{...laneAttributes(lane.from,lane.to,lane.offset),d:path.getAttribute("d"),class:"gate-edge-halo","data-edge-channel":channel});ui.viewport.insertBefore(halo,path)})
}
function renderOverlay(){
  renderMapOverlay();
  syncFixedMapElements()
}
// An avoided system stays on the map, marked. Removing it would be the one
// thing the rule forbids: the pilot asked not to be routed through it, not to
// stop being shown it, and a system that has vanished cannot be un-avoided from
// the map or reasoned about at all.
//
// Hard and soft are marked differently because they behave differently - one is
// never routed, the other is routed around where there is a way around - and a
// marking that collapsed them would say less than the list does.
function markAvoided(){
  if(!state.overrides||!avoidanceApplied())return;
  for(const node of state.nodes){
    // Already excluded by the route's own limits or typed list: leave it. That
    // is the stronger statement of the two, and a node carrying both markings
    // would be drawn in two conflicting styles.
    if(node.el.classList.contains("excluded"))continue;
    const pairs=state.mode==="region"
      ?[["system",node.record.system_id],["region",node.record.region_id]]
      :[["region",node.record.region_id]];
    if(pairs.some(([target,key])=>isBlocked(state.overrides,target,key)))node.el.classList.add("excluded");
    else if(pairs.some(([target,key])=>isDiscouraged(state.overrides,target,key)))node.el.classList.add("avoided")
  }
}
// --- threat reach ------------------------------------------------------------
//
// "Standing here, what can drop on me." Pure arithmetic off the archive - jump
// ranges from the SDE, distances from the coordinates - so it works with no
// connectivity and no token, which is why it is worth having at all: the thing
// it answers is otherwise only knowable from intel nobody will share.
//
// Deliberately an upper bound. Maximum skills, every staging system live, and
// no cyno jammers, because jammers cannot be detected by any third-party tool.
// A threat model that flatters you is worse than none, so every surface that
// shows this says so.
const THREAT_KEY = STORAGE_KEYS.threat ?? "new-eden-atlas-threat-v1";

function runThreat(){
  ui.threatError.textContent="";
  // Every path that refuses to produce an envelope clears the one on the map
  // first. Two of the three did not, so a refusal could leave the previous
  // envelope drawn while the message said the figures were unavailable - the
  // input saying one thing and the markings saying another, which is the
  // failure the route panel fixed and which matters more here.
  if(!state.jumpPlanner){
    clearThreat();
    ui.threatError.textContent="Ship data is unavailable, so jump ranges cannot be computed.";
    return
  }
  const names=avoidEntries(ui.threatStaging.value);
  if(!names.length){
    clearThreat();
    return
  }
  const staging=[];
  for(const name of names){
    const system=state.jumpPlanner.resolveSystem(name);
    // Refused at the point of entry rather than quietly dropped. A staging
    // system silently missing from the set shrinks the envelope, and a
    // threat envelope that is too small is the one kind of wrong that gets
    // people killed.
    if(!system){
      // Clear what is drawn before saying why. Leaving it is the failure the
      // route panel had already fixed - the input saying one thing and the
      // markings on the map saying another - reproduced in the overlay where
      // being wrong costs the most.
      clearThreat();
      ui.threatError.textContent=`Staging: no single system matches "${name}".`;
      return
    }
    staging.push(system.system_id)
  }
  const classes=threatClasses({ships:state.jumpPlanner.ships,skills:state.jumpPlanner.skills});
  if(!classes.length){
    clearThreat();
    ui.threatError.textContent="No jump-capable hulls in the ship data.";
    return
  }
  const envelopes=threatEnvelope(state.jumpPlanner,staging,classes);
  const reached=new Set();
  for(const envelope of envelopes)for(const id of envelope.systemIds)reached.add(id);
  state.threat={envelopes,staging,systemIds:reached};
  state.threatInputs=keyFor(THREAT_FIELDS,threatValues());
  saveThreatSettings();
  renderThreatClasses();
  renderOverlay();
  legend(state.mode);
  if(state.selected&&state.region?.systems?.[state.selected])showSystem(state.region.systems[state.selected])
}

function clearThreat(){
  state.threat=null;
  state.threatInputs=null;
  ui.threatError.textContent="";
  renderThreatClasses();
  renderOverlay();
  if(state.atlas)legend(state.mode);
  if(state.selected&&state.region?.systems?.[state.selected])showSystem(state.region.systems[state.selected])
}

// What reaches one system, or null when no staging has been set. The caller
// must keep those apart: an empty list is a computed answer and null is the
// absence of a question, and an inspector that showed them the same way would
// report "nothing reaches you" to a pilot who never asked.
function threatsToSystem(systemId){
  return state.threat?threatsTo(state.threat.envelopes,systemId):null
}

function renderThreatClasses(){
  if(!ui.threatClasses)return;
  ui.threatClasses.innerHTML=threatRows(state.threat?.envelopes??[])
}

function saveThreatSettings(){
  writeJson(localStorage,THREAT_KEY,{staging:ui.threatStaging.value})
}

function restoreThreatSettings(){
  const saved=readJson(localStorage,THREAT_KEY);
  if(!saved)return;
  // `saved.highSec` is read from nothing on purpose. A stored `true` from
  // before the option was removed simply stops meaning anything, which is the
  // right outcome: it only ever asked for an envelope that cannot exist.
  ui.threatStaging.value=saved.staging||""
}

// The envelope is not redrawn on load. It is derived, it is expensive, and a
// pilot returning to the tool should see the map as it is rather than an
// envelope they did not ask for - the staging list is remembered so that
// asking again is one click.
function bindThreat(){
  $("runThreat").onclick=runThreat;
  $("clearThreat").onclick=()=>{ui.threatStaging.value="";saveThreatSettings();clearThreat()};
  ui.threatStaging.addEventListener("keydown",event=>{if(event.key==="Enter")runThreat()});
  // **The listener that was missing.** Without it, editing the staging list and
  // tabbing away left the old envelope drawn and answering, because nothing
  // else on this panel fires. Every other result panel binds `change` on every
  // field it depends on; this one bound none.
  ui.threatStaging.addEventListener("change",()=>{saveThreatSettings();invalidateStaleResults()})
}

// Marked on the map, and never merged with the route markings: a system can be
// on your route and inside a hostile envelope at once, and that combination is
// the most important thing the map can tell you.
function markThreat(){
  if(!state.threat)return;
  for(const node of state.nodes){
    if(state.mode==="region"){
      if(state.threat.systemIds.has(node.record.system_id))node.el.classList.add("threatened");
      continue
    }
    if(node.record.systems?.some(id=>state.threat.systemIds.has(id)))node.el.classList.add("threatened")
  }
}

// Incursion and frontline markings, drawn alongside everything else rather
// than instead of it. A system can be infested, contested, on your route and
// inside a hostile envelope at once, and each of those is a separate reason to
// think twice.
function markAmbient(){
  if(!ambientKnown()||!state.live)return;
  const infested=incursionSystems(state.live),front=frontlineSystems(state.live);
  for(const node of state.nodes){
    if(state.mode!=="region"){
      if(node.record.systems?.some(id=>infested.has(Number(id))))node.el.classList.add("infested");
      continue
    }
    const id=node.record.system_id;
    if(infested.has(id))node.el.classList.add("infested");
    const line=front.get(id);
    if(line&&line.contested!=="uncontested"&&line.contested!=="unknown")node.el.classList.add("contested")
  }
}
// The lane a link was drawn in, either way round - the jump list stores one
// direction and a route may walk it the other.
function laneFor(fromId,toId){
  return state.lanes?.get(`${fromId}-${toId}`)??state.lanes?.get(`${toId}-${fromId}`)??0
}
function renderMapOverlay(){
  lastLaneInverse = null;
  ui.viewport.querySelectorAll(".route-layer").forEach(node=>node.remove());
  styleGateEdges();
  ui.viewport.classList.toggle("viewport-has-overlay",Boolean((state.route&&state.routeIndex)||(state.jump&&state.jumpIndex)||state.range));
  for(const node of state.nodes)node.el.classList.remove("on-route","on-jump","route-endpoint","excluded","avoided","in-range","threatened","infested","contested","timer-live","timer-soon");
  if (state.avoid && state.limits && state.routePlanner) {
    for (const node of state.nodes) {
      const excluded = state.mode === "region"
        ? state.routePlanner.isBlocked(node.record.system_id, state.avoid, state.limits)
        : state.avoid.regionIds.has(node.record.region_id);
      node.el.classList.toggle("excluded", excluded);
    }
  }
  markAvoided();
  markThreat();
  markAmbient();
  markCampaigns();
  const isJump=Boolean(state.jumpIndex&&state.jump),index=isJump?state.jumpIndex:state.routeIndex,plan=isJump?state.jump:state.route,wantRoute=Boolean(index&&plan&&state.positions);
  if(!wantRoute&&!state.range)return;
  const overlayClass=isJump?" jump-overlay":"",lines=S("g",{class:`route-layer route-lines${overlayClass}`}),marks=S("g",{class:`route-layer route-marks${overlayClass}`});
  drawRangeRings(lines,marks);
  if(!wantRoute){
    const firstNode=ui.viewport.querySelector(".system-node,.region-node");
    firstNode?ui.viewport.insertBefore(lines,firstNode):ui.viewport.appendChild(lines);
    ui.viewport.appendChild(marks);
    return
  }
  if(state.mode==="region"){
    const local=state.region.systems,path=plan.systems;
    for(let step=1;step<path.length;step+=1){
      const from=local[path[step-1].system_id],to=local[path[step].system_id];
      if(!from||!to)continue;
      const a=state.positions.get(from),b=state.positions.get(to);
      if(a&&b){
        const offset=laneFor(from.system_id,to.system_id);
        routeSegment(lines,"path",{...laneAttributes(a,b,offset),d:lanePath(a,b,offset,currentInverse())})
      }
    }
    for(const node of state.nodes){
      const step=index.order.get(node.record.system_id);
      if(step===undefined)continue;
      const endpoint=node.record.system_id===index.originId||node.record.system_id===index.destinationId;
      node.el.classList.add(isJump?"on-jump":"on-route");
      if(endpoint)node.el.classList.add("route-endpoint");
      const point=state.positions.get(node.record),width=Math.max(68,node.record.name.length*7+20);
      if(point)routeBadge(marks,point.x,point.y,String(step),endpoint,-width/2,-15)
    }
  }else{
    const byId=state.atlas.regions;
    for(let step=1;step<index.regionOrder.length;step+=1){
      const a=state.positions.get(byId[index.regionOrder[step-1]]),b=state.positions.get(byId[index.regionOrder[step]]);
      if(a&&b)routeSegment(lines,"line",{x1:a.x,y1:a.y,x2:b.x,y2:b.y})
    }
    for(const node of state.nodes){
      if(!index.regionIds.has(node.record.region_id))continue;
      node.el.classList.add(isJump?"on-jump":"on-route");
      if(node.record.region_id===index.regionOrder[0]||node.record.region_id===index.regionOrder.at(-1))node.el.classList.add("route-endpoint")
    }
  }
  const firstNode=ui.viewport.querySelector(".system-node,.region-node");
  firstNode?ui.viewport.insertBefore(lines,firstNode):ui.viewport.appendChild(lines);
  ui.viewport.appendChild(marks)
}
function clearRoute(){
  state.route=null;
  state.routeIndex=null;
  state.routeInputs=null;
  ui.routeError.textContent="";
  renderOverlay();
  legend(state.mode);
  if(ui.content.querySelector("[data-route-system]")){
    ui.content.hidden=true;
    ui.content.innerHTML="";
    ui.empty.hidden=false;
    ui.inspector.classList.remove("open")
  }
}
function showRoute(route){
  display(routePanel(route, id => state.atlas.regions[id].name), "route");
  ui.content.querySelectorAll("[data-route-system]")
  .forEach(button => { button.onclick = () => loadRegion(button.dataset.routeRegion, +button.dataset.routeSystem); });
}
function corridorSettings(){
  return{
    from: ui.routeFrom.value,
    to: ui.routeTo.value,
    mode: ui.routeMode.value,
    avoidSystems: ui.avoidSystems.value,
    avoidRegions: ui.avoidRegions.value,
    minSecurity: ui.routeMinSec.value,
    maxSecurity: ui.routeMaxSec.value
  }
}
function corridorDetail(corridor){
  const parts=[`${corridor.from} \u2192 ${corridor.to}`];
  if(corridor.mode!=="shortest")parts.push({safer:"high-sec",["less-secure"]:"low/null"}[corridor.mode]);
  const bounds=[corridor.minSecurity&&`\u2265${corridor.minSecurity}`,corridor.maxSecurity&&`\u2264${corridor.maxSecurity}`].filter(Boolean);
  if(bounds.length)parts.push(bounds.join(" "));
  const listed=avoidEntries(corridor.avoidSystems).length+avoidEntries(corridor.avoidRegions).length;
  if(listed)parts.push(`${listed} avoided`);
  return parts.join(" \u00b7 ")
}
function renderCorridors(){
  ui.corridorSummary.innerHTML = corridorSummaryMarkup(state.corridors.length);
  ui.corridorList.innerHTML = corridorRows(state.corridors, corridorDetail);
  ui.corridorList.querySelectorAll("[data-corridor]")
    .forEach(button => { button.onclick = () => loadCorridor(button.dataset.corridor); });
  ui.corridorList.querySelectorAll("[data-drop]")
    .forEach(button => { button.onclick = () => dropCorridor(button.dataset.drop); });
}
// Returns whether the write actually happened, so a caller can stop rather than
// paint a success message over the failure. It wrote the error itself and
// returned nothing, and the import then overwrote it with "Imported 4 new" -
// leaving the pilot believing they held a shared corridor set that was never
// stored, which is exactly what the all-or-nothing import rule exists to avoid.
function persistCorridors(){
  const stored=writeCorridors(localStorage,state.corridors);
  if(!stored)ui.corridorError.textContent="Corridors could not be stored. Browser storage may be full or blocked.";
  renderCorridors();
  return stored
}
function saveCorridor(){
  ui.corridorError.textContent="";
  try{
    const name=ui.corridorName.value.trim();
    if(!name)throw new Error("Give the corridor a name before saving.");
    if(!state.routePlanner.resolveSystem(ui.routeFrom.value))throw new Error(`Origin "${ui.routeFrom.value||"(empty)"}" does not match a single system.`);
    if(!state.routePlanner.resolveSystem(ui.routeTo.value))throw new Error(`Destination "${ui.routeTo.value||"(empty)"}" does not match a single system.`);
    state.routePlanner.resolveAvoid(ui.avoidSystems.value,ui.avoidRegions.value);
    state.routePlanner.resolveLimits(ui.routeMinSec.value,ui.routeMaxSec.value);
    state.corridors=upsertCorridor(state.corridors,normalizeCorridor({name,...corridorSettings()},ROUTE_MODES));
    ui.corridorName.value="";
    persistCorridors()
  }catch(error){
    ui.corridorError.textContent=error.message
  }
}
function loadCorridor(name){
  const corridor=state.corridors.find(entry=>entry.name===name);
  if(!corridor)return;
  ui.corridorError.textContent="";
  ui.routeFrom.value=corridor.from;
  ui.routeTo.value=corridor.to;
  ui.routeMode.value=corridor.mode;
  ui.avoidSystems.value=corridor.avoidSystems;
  ui.avoidRegions.value=corridor.avoidRegions;
  ui.routeMinSec.value=corridor.minSecurity;
  ui.routeMaxSec.value=corridor.maxSecurity;
  ui.corridorName.value=corridor.name;
  if(corridor.avoidSystems||corridor.avoidRegions||corridor.minSecurity||corridor.maxSecurity)ui.limitsPanel.open=true;
  refreshAvoid();
  saveRouteSettings();
  calculateRoute()
}
function dropCorridor(name){
  ui.corridorError.textContent="";
  state.corridors=removeCorridor(state.corridors,name);
  persistCorridors()
}
function exportCorridors(){
  ui.corridorError.textContent="";
  if(!state.corridors.length){
    ui.corridorError.textContent="There are no corridors to export.";
    return
  }
  const blob=new Blob([corridorFile(state.corridors)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;
  link.download="new-eden-atlas-corridors.json";
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),0)
}
async function importCorridors(event){
  const file=event.target.files?.[0];
  if(!file)return;
  ui.corridorError.textContent="";
  try{
    const incoming=parseCorridorFile(await file.text(),ROUTE_MODES),result=mergeCorridors(state.corridors,incoming);
    state.corridors=result.list;
    // Only claim the import if it was written. persistCorridors has already
    // said why if it was not.
    if(persistCorridors())ui.corridorError.textContent=`Imported ${result.added} new, updated ${result.updated} existing.`
  }catch(error){
    ui.corridorError.textContent=error.message
  }finally{
    event.target.value=""
  }
}
function bindCorridors(){
  state.corridors=sortCorridors(readCorridors(localStorage,ROUTE_MODES));
  renderCorridors();
  $("saveCorridor").onclick=saveCorridor;
  $("exportCorridors").onclick=exportCorridors;
  $("importCorridors").onclick=()=>ui.corridorFileInput.click();
  ui.corridorFileInput.onchange=importCorridors;
  ui.corridorName.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();saveCorridor()}})
}
const JUMP_KEY = STORAGE_KEYS.jump;
function populateModules(){
  if (!state.jumpPlanner) return;
  ui.jumpFuelModule.innerHTML = fuelModuleOptions(state.jumpPlanner.fuelModules);
}
function populateShips(){
  if (!state.jumpPlanner) return;
  ui.jumpShip.innerHTML = shipOptions(state.jumpPlanner.ships);
}
function saveJumpSettings(){
  writeJson(localStorage, JUMP_KEY, {
    ship: ui.jumpShip.value,
    from: ui.jumpFrom.value,
    to: ui.jumpTo.value,
    calibration: ui.jumpCalibration.value,
    conservation: ui.jumpConservation.value,
    hullSkill: ui.jumpHullSkill.value,
    fuelModule: ui.jumpFuelModule.value,
    highSec: ui.jumpHighSec.checked,
  });
}
function restoreJumpSettings(){
  const saved = readJson(localStorage, JUMP_KEY);
  if (!saved) return;
  if(saved.ship)ui.jumpShip.value=saved.ship;
  ui.jumpFrom.value=saved.from||"";
  ui.jumpTo.value=saved.to||"";
  if(saved.calibration!==undefined)ui.jumpCalibration.value=saved.calibration;
  if(saved.conservation!==undefined)ui.jumpConservation.value=saved.conservation;
  if(saved.hullSkill!==undefined)ui.jumpHullSkill.value=saved.hullSkill;
  if(saved.fuelModule!==undefined)ui.jumpFuelModule.value=saved.fuelModule;
  ui.jumpHighSec.checked=Boolean(saved.highSec)
}
function planJump(){
  ui.jumpError.textContent="";
  try{
    if(!state.jumpPlanner)throw new Error("Ship data is still loading.");
    state.jump=state.jumpPlanner.plan(ui.jumpFrom.value,ui.jumpTo.value,{shipValue:ui.jumpShip.value,calibration:ui.jumpCalibration.value,conservation:ui.jumpConservation.value,hullSkill:ui.jumpHullSkill.value,fuelModule:ui.jumpFuelModule.value});
    state.jumpIndex=buildRouteIndex(state.jump);
    state.jumpInputs=keyFor(JUMP_FIELDS,jumpValues());
    clearRouteResult();
    ui.jumpFrom.value=state.jump.systems[0].name;
    ui.jumpTo.value=state.jump.systems.at(-1).name;
    saveJumpSettings();
    renderOverlay();
    legend(state.mode);
    showJump(state.jump)
  }catch(error){
    clearJumpResult();
    ui.jumpError.textContent=error.message
  }
}
function showJump(plan){
  display(jumpPanel(plan, id => state.atlas.regions[id].name), "jump");
  ui.content.querySelectorAll("[data-jump-system]")
  .forEach(button => { button.onclick = () => loadRegion(button.dataset.jumpRegion, +button.dataset.jumpSystem); });
}
function bindJump(){
  $("planJump").onclick=planJump;
  ui.rangeRings.onclick=toggleRangeRings;
  for(const input of[ui.jumpFrom,ui.jumpTo,ui.jumpCalibration,ui.jumpConservation,ui.jumpHullSkill])input.addEventListener("keydown",event=>{if(event.key==="Enter")planJump()});
  const jumpInputs = [
    ui.jumpShip, ui.jumpCalibration, ui.jumpConservation,
    ui.jumpHullSkill, ui.jumpFuelModule, ui.jumpHighSec,
  ];
  for (const input of jumpInputs) {
    input.addEventListener("change", () => {
      saveJumpSettings();
      describeShipFuel();
      invalidateStaleResults();
    });
  }
  for(const input of[ui.jumpFrom,ui.jumpTo])input.addEventListener("change",invalidateStaleResults)
}
function toggleRangeRings(){
  if(state.range){
    clearRangeRings();
    return
  }
  ui.jumpError.textContent="";
  try{
    if(!state.jumpPlanner)throw new Error("Ship data is still loading.");
    const ship=state.jumpPlanner.resolveShip(ui.jumpShip.value);
    if(!ship)throw new Error(`Ship not found or ambiguous: ${ui.jumpShip.value||"(empty)"}`);
    const origin=state.jumpPlanner.resolveSystem(ui.jumpFrom.value);
    if(!origin)throw new Error(`Origin system not found or ambiguous: ${ui.jumpFrom.value||"(empty)"}`);
    if(!state.jumpPlanner.isReachable(origin))throw new Error(`${origin.name} is not on the stargate network and cannot be jumped from.`);
    const range=state.jumpPlanner.rangeFor(ship,ui.jumpCalibration.value)*state.jumpPlanner.rangeMultiplierFor(ship,ui.jumpHullSkill.value);
    state.range={
      ...state.jumpPlanner.rangeSet(origin.system_id,range,{allowHighSec:ui.jumpHighSec.checked}),origin,ship
    };
    state.rangeInputs=keyFor(RANGE_FIELDS,jumpValues());
    ui.rangeRings.setAttribute("aria-pressed","true");
    renderOverlay();
    legend(state.mode);
    showRange(state.range)
  }catch(error){
    ui.jumpError.textContent=error.message
  }
}
function clearRangeRings(){
  state.range=null;
  state.rangeInputs=null;
  ui.rangeRings.setAttribute("aria-pressed","false");
  if(ui.content.querySelector("[data-range-system]")){
    ui.content.hidden=true;
    ui.content.innerHTML="";
    ui.empty.hidden=false
  }
  renderOverlay();
  legend(state.mode)
}
function drawRangeRings(lines,marks){
  const range=state.range;
  if(!range)return;
  if(state.mode==="universe"){
    if(!state.projection)return;
    const centre=state.projection.toScreen([range.origin.position[0],-range.origin.position[2]]);
    // The projection is a single uniform scale, so a light-year has a fixed size
    // on screen and the ring can be drawn at a radius that means something.
    const radius=range.rangeLy*state.projection.scale*METERS_PER_LIGHT_YEAR;
    lines.append(S("circle",{cx:centre.x,cy:centre.y,r:radius,class:"range-ring"}));
    marks.append(S("circle",{cx:centre.x,cy:centre.y,r:5,class:"range-origin"}));
    for(const node of state.nodes)if(range.regionIds.has(node.record.region_id))node.el.classList.add("in-range");
    return
  }
  for(const node of state.nodes){
    if(!range.systemIds.has(node.record.system_id))continue;
    const point=state.positions?.get(node.record);
    if(!point)continue;
    const width=Math.max(68,node.record.name.length*7+20)+RANGE_OUTLINE_PADDING,marker=pinMapElement(S("g",{class:"range-node-anchor"}),point.x,point.y);
    marker.append(S("rect",{x:-width/2,y:-RANGE_OUTLINE_HEIGHT/2,width,height:RANGE_OUTLINE_HEIGHT,rx:RANGE_OUTLINE_HEIGHT/2,class:"range-node"}));
    lines.append(marker)
  }
}
function showRange(range){
  display(rangePanel(range, id => state.atlas.regions[id].name, secClass), "range");
  ui.content.querySelectorAll("[data-range-system]")
  .forEach(button => { button.onclick = () => loadRegion(button.dataset.rangeRegion, +button.dataset.rangeSystem); });
}
function describeShipFuel(){
  if(!state.jumpPlanner)return;
  const ship=state.jumpPlanner.resolveShip(ui.jumpShip.value);
  if(!ship){
    ui.jumpFuelNote.textContent="";
    return
  }
  const bonus=ship.hull_fuel_bonus;
  ui.jumpHullLabel.firstChild.nodeValue=bonus?bonus.skill.replace(/^Jump /,"").slice(0,12):"Hull";
  ui.jumpHullLabel.classList.toggle("inactive",!bonus);
  ui.jumpHullSkill.disabled=!bonus;
  const perLy=state.jumpPlanner.fuelPerLy(ship,ui.jumpConservation.value,ui.jumpHullSkill.value,ui.jumpFuelModule.value);
  const range=state.jumpPlanner.rangeFor(ship,ui.jumpCalibration.value)*state.jumpPlanner.rangeMultiplierFor(ship,ui.jumpHullSkill.value);
  ui.jumpFuelNote.textContent=`${ly(range)} \u00b7 ${Math.round(perLy).toLocaleString()} ${state.jumpPlanner.fuelTypeName(ship)} per ly${bonus?` \u00b7 ${bonus.skill} applies`:""}`
}
function currentTacticalConfig(){
  return normalizeTacticalConfig({
    preset: ui.tacticalPreset.value,
    depth: ui.tacticalDepth.value,
    blocks: {
      security: ui.blockSecurity.checked,
      approaches: ui.blockApproaches.checked,
      chokes: ui.blockChokes.checked,
      borders: ui.blockBorders.checked,
    },
  })
}
function applyTacticalConfig(config){
  const normalized=normalizeTacticalConfig(config);
  ui.tacticalPreset.value=normalized.preset;
  ui.tacticalDepth.value=normalized.depth;
  ui.blockSecurity.checked=normalized.blocks.security;
  ui.blockApproaches.checked=normalized.blocks.approaches;
  ui.blockChokes.checked=normalized.blocks.chokes;
  ui.blockBorders.checked=normalized.blocks.borders;
  writeJson(localStorage, TACTICAL_KEY, normalized)
}
function applyTacticalPreset(name){
  const preset=TACTICAL_PRESETS[name]||TACTICAL_PRESETS.hunt;
  applyTacticalConfig({preset:name,depth:preset.depth,blocks:preset.blocks})
}
function runTacticalBrief(){
  ui.tacticalError.textContent="";
  try{
    if(!state.tacticalAnalyzer)throw new Error("Tactical archive is still loading.");
    const config=currentTacticalConfig();
    state.tactical=state.tacticalAnalyzer.analyze(ui.tacticalSystem.value,config.depth);
    ui.tacticalSystem.value=state.tactical.focal.name;
    writeJson(localStorage, TACTICAL_KEY, config);
    showTacticalBrief(state.tactical,config);
    if(window.matchMedia("(max-width: 760px)").matches){
      ui.rail.classList.remove("open");
      ui.toolsToggle.setAttribute("aria-expanded","false");
      ui.toolsToggle.setAttribute("aria-label","Open navigation and planning tools")
    }
  }catch(error){
    // **What is drawn goes before the reason is given**, as `runThreat`,
    // `calculateRoute` and `planJump` all do.
    //
    // Refusing without clearing leaves the *previous* brief fully on screen: the input
    // says one system, the panel says another, `state.tactical` says nothing at all,
    // and the "Ask about this brief" opener is still live and still holding the old
    // snapshot. That is the named failure - "the input saying one thing and the
    // markings on the map saying
    // another" - on the one surface that feeds the advisor.
    //
    // `clearBrief` takes the panel, the snapshot, the panel read and the opener
    // together, because they are one thing on screen.
    state.tactical=null;
    clearBrief();
    ui.tacticalError.textContent=error.message
  }
}

// Everything the brief put on screen, removed together. `display` already
// clears the snapshot and unbinds the read; this is the empty panel plus the
// opener, which lives outside the template.
function clearBrief(){
  if(!ui.content)return;
  // Only if a brief is what is on screen. A refusal must not wipe a route panel a
  // pilot left open, which is the mirror of the rule above.
  if(state.panel!=="brief")return;
  state.panel=null;
  state.briefSnapshot=null;
  state.panelRead={key:null,forSnapshot:null,text:null};
  ui.content.hidden=true;
  ui.content.innerHTML="";
  ui.empty.hidden=false
}
// **The snapshot is minted here, on the brief path, and not at the button.**
//
// The order is: brief computed, snapshot frozen, briefing rendered from it, and
// the button forks *that* snapshot. Building one at the button instead would
// mean reading a briefing about one state and then asking questions about
// another - nothing would look wrong, and the window would be answering about a
// universe the briefing never described.
//
// Nothing in this application called `buildSnapshot` before this line, so this
// is also the first place its throwing matters. It throws rather than faulting -
// `structuredClone` raises a `DOMException` on anything it cannot clone, which
// is not a `TypeError` and would not be caught by a guard written for one. A
// brief that cannot be snapshotted is still a brief: the panel renders, and the
// opener is simply absent, which is the same degradation rule the whole
// optional layer follows.
function mintBriefSnapshot(report, brief) {
  try {
    return buildSnapshot({
      now: Date.now(),
      archive: state.atlas,
      report,
      brief,
      // No characters and no routing inputs yet: there is no travelling-character
      // selector, so there is no numeric character id to key a routing record by.
      // That is not a gap being papered over - a routing operation asked about a
      // character the snapshot has no inputs for **refuses**, which is the
      // designed behaviour and the safe direction. Guessing an empty avoid list
      // would route a pilot through a gate they had typed in themselves.
      //
      // No live layers either. A layer that is not offered reads as "never ran",
      // which is exactly true: nothing assembles them into a snapshot yet. The
      // dangerous direction is the other one - a layer assembled wrongly writes
      // `synced` with a timestamp into a frozen record, which is the one
      // forbidden fact in this whole design.
    });
  } catch (error) {
    // Degrading is right; degrading silently is not. Without this the opener
    // simply never appears again, and that looks exactly like having no
    // sidecar - two different faults with one symptom and no way to tell them
    // apart from the outside.
    if (typeof console !== "undefined" && console.warn) {
      console.warn("this brief could not be snapshotted, so it cannot be asked about:", error);
    }
    return null;
  }
}

function showTacticalBrief(report,config){
  const brief = buildOperationalBrief(report, config.preset);
  // Minted before the panel is drawn and assigned after it, because `display`
  // clears the field - the briefing and the snapshot it was taken from appear
  // on screen together or not at all.
  const snapshot = mintBriefSnapshot(report, brief);
  display(tacticalPanel(
    report,
    brief,
    config,
    id => state.atlas.regions[id].name,
    new Date(report.generatedAt).toLocaleString(),
  ), "brief");
  state.briefSnapshot = snapshot;
  // Fire and forget, never awaited: the brief draws now and the opener appears
  // if and when an answer comes back. An optional layer does not get to delay
  // the surface it is optional to.
  refreshAdvisorAvailability();
  // Same rule, and for the same reason: fired and not awaited. A brief that
  // waited on this would be a brief that an absent sidecar could delay.
  //
  // Kept rather than dropped, because "not awaited here" is not the same as
  // "unobservable". A dropped promise is a turn a test can only reach for by
  // draining microtasks and hoping, which is a test that passes for timing
  // reasons and fails for them too.
  ui.content.querySelectorAll("[data-tactical-system]")
    .forEach(button => { button.onclick = () => loadRegion(button.dataset.tacticalRegion, +button.dataset.tacticalSystem); });
  renderAskOpener();
  // **Last, after everything the brief needs to work.** It cannot throw
  // synchronously today - every call inside it is guarded - but it is the
  // optional layer, and it sat above the line that binds the brief's system
  // buttons. `runTacticalBrief` catches, nulls `state.tactical` and leaves a
  // fully rendered brief whose buttons do nothing; an optional layer must not
  // be able to reach that, whatever it does later.
  state.panelReadPending = requestPanelRead();
}

// --- the ask window ----------------------------------------------------------
//
// Absent rather than disabled, which is the rule `bindVault` already follows: a
// control a build cannot honour invites a pilot to go looking for the thing
// that is not there. With no snapshot there is nothing to ask about, so there
// is no opener - not a greyed-out one.
function askAvailable() {
  return Boolean(state.briefSnapshot) && state.advisorUp === true;
}

// Asked of the core, because asking the advisor whether the advisor is running
// is a question that cannot be answered when the answer is no.
//
// Any failure leaves this false. A browser build has no core at all, a desktop
// build with no sidecar answers false, and a core that refuses is not evidence
// that a sidecar is there - all three mean no opener, which is the same
// degradation the whole optional layer follows.
function refreshAdvisorAvailability() {
  return callCore("advisor.available")
    .then((running) => { state.advisorUp = running === true; })
    .catch(() => { state.advisorUp = false; })
    .then(() => { renderAskOpener(); return state.advisorUp; });
}

function renderAskOpener() {
  if (!ui.content) return;
  const existing = ui.content.querySelector("[data-ask-open]");
  if (existing) existing.remove();
  if (!askAvailable()) return;
  if (typeof document === "undefined" || !document.createElement) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ask-open";
  // `setAttribute`, not `dataset`. Both work in a browser; only this one is
  // visible to a selector in the test shim, and a control no test can find is
  // a control no test is checking.
  button.setAttribute("data-ask-open", "1");
  button.textContent = "Ask about this brief";
  // The fault is shown rather than dropped. At `WINDOW_LIMIT` this button did
  // nothing at all - no window, no message, no change - while `openWindow` had
  // already composed the sentence explaining why.
  button.onclick = () => {
    const opened = openAsk();
    if (opened && opened.fault) ui.tacticalError.textContent = opened.fault;
  };
  ui.content.append(button);
}

function openAsk() {
  const opened = openWindow(state.askWindows, state.briefSnapshot, { now: Date.now() });
  if (opened.fault) return opened;
  renderAskWindows();
  return opened;
}

function closeAsk(id) {
  const closed = closeWindow(state.askWindows, id);
  if (closed) renderAskWindows();
  return closed;
}

// Every open window, redrawn. Each renders from the snapshot **it** forked, so
// two windows opened either side of a refresh show different ages and neither
// is wrong.
function renderAskWindows() {
  if (!ui.askLayer) return;
  const open = state.askWindows.open;
  // **A rebuild must not eat what a pilot is typing.** This replaced every
  // window's markup on every open, close, answer and refusal - and a
  // `<textarea>`'s value is DOM state rather than markup, so it went with it.
  // Three reachable ways to lose a question: another window's answer arriving,
  // any other window closing, and - worst - the refusal path, which told a
  // pilot their question was too long having just deleted it. The module
  // refuses to truncate on the grounds that a truncated question is a different
  // question; discarding it outright is worse than either.
  const scrolled = new Map();
  for (const node of ui.askLayer.querySelectorAll("[data-ask-window]")) {
    scrolled.set(node.dataset.askWindow, node.scrollTop);
  }
  for (const form of ui.askLayer.querySelectorAll("[data-ask-form]")) {
    const held = windowOf(state.askWindows, form.dataset.askForm);
    const input = form.querySelector(".ask-input");
    if (held && input) held.draft = input.value;
  }
  ui.askLayer.hidden = open.length === 0;
  ui.askLayer.innerHTML = open.map(record => windowTemplate(record, { now: Date.now() })).join("");
  for (const node of ui.askLayer.querySelectorAll("[data-ask-window]")) {
    // A reply landing scrolled the window back to the top, putting the answer
    // the pilot asked for below the fold with nothing saying it had arrived.
    const held = scrolled.get(node.dataset.askWindow);
    if (Number.isFinite(held)) node.scrollTop = held;
  }
  for (const button of ui.askLayer.querySelectorAll("[data-ask-close]")) {
    button.onclick = () => closeAsk(button.dataset.askClose);
  }
  for (const form of ui.askLayer.querySelectorAll("[data-ask-form]")) {
    form.onsubmit = event => {
      event.preventDefault();
      submitAsk(form.dataset.askForm, form.querySelector(".ask-input")?.value ?? "");
    };
  }
}

// The question, bounded before anything else looks at it.
//
// With no transport, a question is cleaned, refused if it cannot be cleaned, and then
// reported as having nowhere to go - which is a different message from "the advisor
// said nothing", and the difference is the one most of these rules are about.
// One turn: build the request, send it, and hand the reply to the code that
// decides whether it may be believed.
//
// **Nothing partial is ever shown.** `consider` refuses the whole reply if one
// operation faults, and this does not go looking for the parts that survived -
// a brief that is three quarters right reads as complete, and the missing
// quarter is the part a pilot would have acted on differently.
//
// --- what a turn reaches for ------------------------------------------------

// What an operation is allowed to reach outside the snapshot.
//
// A function rather than an object literal at the call site, so there is one
// place to read and one place to change. It is **not** a thing to assert
// against: a test that checked this function's shape passed while the defect
// was reintroduced at the call site, because the shape was never what was
// wrong. `tests/routing-seam.test.mjs` drives the turn instead, over a link
// that died since the brief was taken.
//
// The comment here once said the opposite of the truth for a day:
// `now: record.snapshot.takenAt` was passed with an argument that a route
// should be planned against the instant the brief was frozen.
//
// It is not. `operations.js` and `routing-inputs.js` both say, at length, that
// expiring links are read against **the present** - a snapshot freezes what was
// observed and cannot freeze the future, and a wormhole's expiry is a claim
// about the future. An hour-old brief would have routed a pilot through a hole
// that died forty minutes ago and reported nothing lapsed. "A caller may pin
// the clock; nothing else may", and this caller has no reason to.
function advisorTools() {
  return { planner: state.routePlanner };
}

// --- the panel read ----------------------------------------------------------
//
// **The one deliberate exception to "every panel is deterministic", and it
// ships off.** Everything else a model touches lives in a window a pilot opened
// in order to speculate, where a wrong read is a wrong sentence. Printed under
// the findings it is not a sentence, it is the order - so this surface is
// bounded harder than the window is, in four ways that are not the default but
// what the switch buys when a pilot turns it on.
//
// **Off.** False with nothing stored, false with something unreadable stored,
// and false whenever the checkbox in front of the pilot says so - which is not
// the same as "false unless storage says true", and the difference is a defect
// this shipped with. `writeJson` returns `false` rather than throwing, so a
// storage failure left `{on:true}` stored while the box read unticked, and the
// authority kept answering on: measured as *checkbox false, readOn() true,
// sentence still under the findings*, with every later brief still spending a
// turn. The control a pilot used has to win in the direction of silence, so
// `readOn` requires the store **and** the box, while `restorePanelReadSetting`
// reads the store alone - or the box would restore itself to off for ever.
//
// **One turn per brief, where a brief is its findings.** Keyed on the systems
// the brief lists, not on the snapshot id: every call to `showTacticalBrief`
// mints a new id, so an id-keyed budget bought a fresh turn on every press of
// **Build brief** - measured at four requests for four identical re-runs. That
// is re-rolling a model until it says something the pilot likes, which is the
// thing the bound is for. Rebuilding the same brief now shows the same
// sentence and asks nothing.
//
// **The snapshot id decides whether the answer may land.** A turn started
// against one brief and answered after another was built is discarded. The
// window has the same check; here it matters more, because a window's answer is
// visibly an answer to a question and this one is just a sentence in a panel.
//
// **No spinner.** The node is absent until there is a read, rather than present
// and empty or present and thinking. An empty container under the findings
// reads as "nothing relates these", which is a claim, and a thinking one puts a
// pilot in front of a model at the moment they are deciding.
// What the store says, which is what the checkbox is restored from.
//
// `Object.hasOwn`, because `JSON.parse` leaves the prototype chain in place: a
// polluted `Object.prototype.on` and a stored `{}` switched this on. No route
// to that exists in this build - `normalizeTacticalConfig` rebuilds every
// imported object - but it is the bug class `snapshot.js` already makes `names`
// and `sets` null-prototype to avoid, and it costs one call to close.
function storedReadOn() {
  const stored = readJsonState(localStorage, READ_KEY);
  return stored.state === "read"
    && Object.hasOwn(stored.value, "on")
    && stored.value.on === true;
}

// And what is actually in force, which needs the checkbox to agree. See the
// note above `readOn`'s bounds: a write that failed must not leave the feature
// running with the switch visibly off.
function readOn() {
  return storedReadOn() && (!ui.panelRead || ui.panelRead.checked === true);
}

// Returns whether the preference survived, because it can fail to. The caller
// says so rather than leaving a pilot to find out at the next reload.
function savePanelReadSetting() {
  return writeJson(localStorage, READ_KEY, { on: Boolean(ui.panelRead && ui.panelRead.checked) });
}

function restorePanelReadSetting() {
  if (!ui.panelRead) return;
  ui.panelRead.checked = storedReadOn();
}

// A full reset, budget included. `display` deliberately does less - it unbinds
// the read from the render and keeps the budget - so the two are not the same
// operation and neither is a copy of the other.
function clearPanelRead() {
  state.panelRead = { key: null, forSnapshot: null, text: null };
  renderPanelRead();
}

// What makes two briefs the same question: the systems they list, in order.
// The snapshot id cannot serve, because it is minted fresh on every render.
function briefKey(snapshot) {
  return (snapshot.findings || []).map((finding) => finding?.system?.system_id ?? "?").join("-");
}

function requestPanelRead() {
  if (!readOn()) return Promise.resolve(null);
  const snapshot = state.briefSnapshot;
  if (!snapshot || typeof snapshot.id !== "string") return Promise.resolve(null);

  // Already answered for these findings. Bind the answer to this render and
  // show it; ask nothing. This is the budget, and it is checked before
  // `advisorUp` so a brief rebuilt after the sidecar died still shows the
  // sentence it already has rather than losing it to an absent process.
  const key = briefKey(snapshot);
  if (state.panelRead.key === key) {
    if (state.panelRead.text) {
      state.panelRead = { ...state.panelRead, forSnapshot: snapshot.id };
      renderPanelRead();
    }
    return Promise.resolve(null);
  }
  if (!state.advisorUp) return Promise.resolve(null);
  // Claimed before the turn rather than after it, so a second call while this
  // one is in flight cannot start another.
  state.panelRead = { key, forSnapshot: null, text: null };

  const built = ask(snapshot, null);
  if (built.fault) return Promise.resolve(null);
  const id = nextCoreId();
  return sendAdvisor(built.op, built.payload, { id })
    .catch((error) => failure(id, "sidecar-absent", reason(error)))
    .then((envelope) => {
      let outcome;
      try {
        outcome = consider(snapshot, envelope, { id, op: built.op, tools: advisorTools(), systemNames: systemNames() });
      } catch {
        return null;
      }
      if (outcome.fault) {
        // The same liveness rule the window follows: a transport that has gone
        // away is worth re-checking, so the opener stops offering it.
        if (outcome.code === "sidecar-absent" || outcome.code === "core-absent") {
          refreshAdvisorAvailability();
        }
        return null;
      }
      // Stale by the time it arrived. Silently dropped - there is nothing for a
      // pilot to do about it and the brief on screen is already complete.
      if (!state.briefSnapshot || state.briefSnapshot.id !== snapshot.id) return null;
      const text = outcome.read && typeof outcome.read.text === "string" ? outcome.read.text : null;
      if (!text) return null;

      // **The sentence must be about every system the brief lists.**
      //
      // `relations.js` checks a relation is true of the findings the model
      // named, and the model names the set. True of a subset is not false, but
      // printed here it is an edit: on a Tama hunt brief listing Tunttaras 0.9,
      // Kedama 0.3 and Isanamo 0.6, a model may name the first and third and
      // render "Tunttaras and Isanamo are in the same region." - dropping the
      // one low-security catch point from a sentence sitting under the catch
      // points. Nothing on the row shows security, so a pilot cannot see what
      // was left out.
      //
      // The ask window is where a partial read belongs; a pilot opened it to
      // speculate. This surface is the order, so it takes the whole set or
      // nothing. It costs nothing measurable: across 42 briefs from 14 origins
      // and three presets, every single one had a relation holding over all of
      // its findings.
      const covered = new Set(Array.isArray(outcome.read.findings) ? outcome.read.findings : []);
      const wanted = (snapshot.findings || []).map((finding) => finding.id);
      if (covered.size !== wanted.length || !wanted.every((id) => covered.has(id))) return null;

      state.panelRead = { key, forSnapshot: snapshot.id, text };
      renderPanelRead();
      return outcome;
    })
    // Terminal, like `advisorTurn`. Nothing downstream handles a rejection and
    // an unhandled one from an optional layer is the layer becoming a defect in
    // the one that is not optional.
    .catch(() => null);
}

// `#brief-read` is the only element in this application that may hold a
// sentence a model had any part in choosing, and `tests/surfaces.test.mjs`
// asserts that. It is inserted here rather than by `tacticalPanel`, so the
// template stays a pure function of the report and the brief - the panel is
// complete without this, which is the shipped state and also every state where
// the sidecar is absent, the read was refused, or the answer came back stale.
function renderPanelRead() {
  if (!ui.content) return;
  for (const id of ["#brief-read-mark", "#brief-read"]) {
    const existing = ui.content.querySelector(id);
    if (existing) existing.remove();
  }
  if (!readOn()) return;
  const held = state.panelRead;
  if (!held.text || !state.briefSnapshot || held.forSnapshot !== state.briefSnapshot.id) return;
  const section = ui.content.querySelector(".command-section");
  if (!section || typeof document === "undefined" || !document.createElement) return;
  // **The label is a node, not a `::before`.** It was generated content, which
  // is not in the DOM by specification - so `textContent`, `innerText`, every
  // serialisation and (in Chromium) a selection copy all drop it. Nothing in
  // this application exports panel text, but an FC selecting the brief and
  // pasting it into fleet chat is the ordinary use, and the advisor's sentence
  // would arrive among the deterministic rows with nothing marking it. On the
  // one surface whose whole danger is that being printed there is the
  // authority, the marking has to travel with the words.
  //
  // Kept beside the read rather than inside it, so `#brief-read` still holds
  // exactly what `relations.js` wrote and the surface test can say so.
  const mark = document.createElement("p");
  mark.id = "brief-read-mark";
  mark.textContent = "Advisor read";
  section.appendChild(mark);

  const node = document.createElement("p");
  node.id = "brief-read";
  // `textContent`, never markup. Every word came from `relations.js`, which
  // wrote them from CCP's own names - but the rule that a read is text and not
  // a template is the rule, and it is cheaper to keep here than to argue from
  // where the string was built.
  node.textContent = held.text;
  section.appendChild(node);
}

function bindPanelRead() {
  if (!ui.panelRead) return;
  ui.panelRead.addEventListener("change", () => {
    // A preference that could not be stored is said out loud. The setting still
    // takes effect now - `readOn` requires the box - but it will not survive a
    // reload, and finding that out by seeing the sentence come back is the
    // worst way to learn it.
    if (!savePanelReadSetting() && ui.tacticalError) {
      ui.tacticalError.textContent =
        "This browser would not store that preference, so it will be back to its old setting next time the page loads.";
    } else if (ui.tacticalError) {
      ui.tacticalError.textContent = "";
    }
    // **The off direction is what this line is for.** Unticking has to take
    // the sentence off the screen now, and nothing else is going to redraw.
    //
    // Off-then-on needs no help from here: the budget is keyed on the brief's
    // findings, so ticking back on reaches `requestPanelRead`, matches the key,
    // re-binds and renders on its own. Narrowing this line to the on-direction alone
    // therefore changes nothing a test can see, which is correct rather than a gap.
    // It stays symmetric anyway, because a
    // render on a state change costs nothing and the off path genuinely needs
    // it.
    renderPanelRead();
    if (ui.panelRead.checked) requestPanelRead();
  });
}

function advisorTurn(record, question) {
  const built = ask(record.snapshot, question);
  if (built.fault) {
    record.asking = false;
    record.error = built.fault;
    renderAskWindows();
    return Promise.resolve(built);
  }
  // Minted here rather than inside `sendAdvisor`, because the reply is checked
  // against it. A transport that both mints the id and reports the reply is a
  // transport that can quietly agree with itself.
  const id = nextCoreId();
  return sendAdvisor(built.op, built.payload, { id }).catch((error) => (
    // `sendAdvisor` resolves on every exit it owns, and this is the one it does
    // not: a rejection from foreign code inside the promise chain. Without it
    // the window sits on `asking: true` for ever, with the form disabled and
    // no error - a spinner with no end, which is the exact failure the
    // transport timeout exists to prevent, arriving through another door.
    failure(id, "sidecar-absent", reason(error))
  )).then((envelope) => {
    record.asking = false;
    // **`tools`, or `jumps_between` can never run.** `operations.js` refuses it
    // without a planner and `evaluateAll` is all-or-nothing, so one unanswerable
    // operation discards every other figure in the reply - and the window reports "no
    // route planner was supplied" for a caller holding one in `state` all along.
    //
    // **No clock is pinned.** This passed `record.snapshot.takenAt`, with a
    // comment arguing that a route should be planned against the instant the
    // brief was frozen. That is the opposite of what this chain decided, twice
    // and at length: `operations.js` says "the present, not the snapshot's
    // instant... an expiring link read against `takenAt` is a route through a
    // wormhole that has since collapsed", and `routing-inputs.js` says a
    // snapshot "freezes what was observed; it cannot freeze the future, and a
    // wormhole's expiry is a claim about the future".
    //
    // An hour-old brief pinned to its own instant routes a pilot through a hole that
    // died forty minutes ago and reports `lapsedLinks: 0`. "A caller may pin the
    // clock; nothing else may" - and this caller has no reason to.
    const outcome = consider(record.snapshot, envelope, { id, op: built.op, tools: advisorTools(), systemNames: systemNames() });
    if (outcome.fault) {
      record.error = outcome.fault;
      // **"Absent rather than disabled" has to keep being true.** Availability
      // was read once at startup and never again, so a sidecar that died an
      // hour in left every later brief still offering to ask it. The pilot
      // learned there was nobody there only after opening a window and typing.
      if (outcome.code === "sidecar-absent" || outcome.code === "core-absent") {
        refreshAdvisorAvailability();
      }
    }
    else {
      record.error = null;
      // `figures`, not `results`. `evaluateAll` returns `{snapshotId, results}`
      // and `consider` renames it on the way out; reading the inner name here
      // yielded `undefined` on every turn, so the window rendered an empty
      // answer for a reply that had measured things correctly. Nothing threw,
      // nothing failed, and the brief was simply blank.
      record.entries.push({
        kind: "answer",
        figures: outcome.figures ?? [],
        read: outcome.read ?? null,
        opinion: outcome.opinion ?? null,
        // The third state, carried rather than collapsed. "Offered no view" and
        // "offered one this side threw away" are different facts, and `opine`
        // over-refuses by design - a model systematically tripping one bound
        // would otherwise look like a terse one, forever, with nothing
        // anywhere recording that it happened.
        opinionRefused: outcome.opinionRefused ?? null,
      });
      trimEntries(record);
    }
    renderAskWindows();
    return outcome;
  }).catch((error) => {
    // **Terminal, so this function has one outcome shape like the transport
    // under it.** `sendAdvisor` resolves on every exit it owns, but `consider`
    // or the render below it can still throw - and `submitAsk` hands this
    // promise to a form's `onsubmit`, which drops it. That is an unhandled
    // rejection, and the window is left looking idle with no answer and no
    // error: the pilot is given nothing to read and nothing to retry.
    record.asking = false;
    record.error = `this turn could not be completed: ${reason(error)}`;
    try {
      renderAskWindows();
    } catch {
      // The renderer is what threw. Saying so twice cannot help, and throwing
      // from a catch would take the failure out of this function again.
    }
    return Object.freeze({ fault: record.error });
  });
}

let askTransport = null;

function setAskTransport(transport) {
  askTransport = typeof transport === "function" ? transport : null;
}

// Wired once, at startup, like every other bind. The availability check is
// fired and not awaited: the map, the brief and the planner do not wait on an
// optional process, and the opener appears when the answer arrives or never.
function bindAsk() {
  setAskTransport(advisorTurn);
  refreshAdvisorAvailability();
}

// Oldest first, and never leaving an answer whose question was dropped: an
// answer on screen with nothing above it reads as the advisor volunteering
// something nobody asked for.
function trimEntries(record) {
  if (record.entries.length > TURN_LIMIT) {
    record.entries.splice(0, record.entries.length - TURN_LIMIT);
  }
  if (record.entries[0] && record.entries[0].kind === "answer") record.entries.shift();
}

function submitAsk(id, text) {
  const record = windowOf(state.askWindows, id);
  if (!record) return null;
  // The rendered form disables itself while a request is out, which is enough
  // for a pilot and not enough for a caller. Two questions in flight on one
  // window would interleave two turns into one log, and the second reply would
  // land under the first question.
  if (record.asking) return record;
  const cleaned = cleanQuestion(text);
  if (cleaned.fault) {
    record.error = cleaned.fault;
    renderAskWindows();
    return cleaned;
  }
  record.error = null;
  record.draft = "";
  record.entries.push({ kind: "question", text: cleaned.question });
  // Trimmed here too, not only on the answer path. With no sidecar every ask
  // pushes a question and no answer, so a pilot who keeps trying grows the log
  // without limit - and every push re-serialises the whole of it into markup.
  trimEntries(record);
  if (!askTransport) {
    record.error = "there is no advisor in this build, so the question went nowhere";
    renderAskWindows();
    return record;
  }
  record.asking = true;
  renderAskWindows();
  return askTransport(record, cleaned.question);
}
function exportTacticalConfig(){
  const config=currentTacticalConfig(),blob=new Blob([JSON.stringify(config,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;
  link.download=`new-eden-atlas-${config.preset}-preset.json`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),0)
}
async function importTacticalConfig(event){
  const file=event.target.files?.[0];
  if(!file)return;
  ui.tacticalError.textContent="";
  try{
    const imported=JSON.parse(await file.text());
    applyTacticalConfig(imported)
  }catch(error){
    ui.tacticalError.textContent=`Preset import failed: ${error.message}`
  }finally{
    event.target.value=""
  }
}
function bindTactical(){
  const saved = readJson(localStorage, TACTICAL_KEY) ?? { preset: "hunt" };
  applyTacticalConfig(saved);
  ui.tacticalPreset.onchange=()=>{
    applyTacticalPreset(ui.tacticalPreset.value);
    if(ui.tacticalSystem.value&&state.tacticalAnalyzer)runTacticalBrief()
  };
  $("runTactical").onclick=runTacticalBrief;
  $("exportTactical").onclick=exportTacticalConfig;
  $("importTactical").onclick=()=>ui.tacticalFile.click();
  ui.tacticalFile.onchange=importTacticalConfig;
  ui.tacticalSystem.addEventListener("keydown",event=>{if(event.key==="Enter")runTacticalBrief()})
}
function bindRoutePlanner(){
  restoreRouteSettings();
  $("calculateRoute").onclick=calculateRoute;
  $("clearRoute").onclick=clearRoute;
  ui.routeHeat?.addEventListener("change",()=>{saveRouteSettings();invalidateStaleResults();if(state.route)calculateRoute()});
  for(const input of[ui.avoidSystems,ui.avoidRegions,ui.routeMinSec,ui.routeMaxSec])input.addEventListener("change",()=>{refreshAvoid();saveRouteSettings();invalidateStaleResults()});
  ui.routeMode.addEventListener("change",()=>{saveRouteSettings();invalidateStaleResults()});
  for(const input of[ui.routeFrom,ui.routeTo])input.addEventListener("change",invalidateStaleResults);
  $("swapRoute").onclick=()=>{
    const origin=ui.routeFrom.value;
    ui.routeFrom.value=ui.routeTo.value;
    ui.routeTo.value=origin;
    saveRouteSettings();
    // Both fields are in ROUTE_FIELDS, so the staleness check agrees the result
    // is stale - it was simply never asked. Until some unrelated change event
    // fired, the panel showed the old route under swapped endpoints.
    if(state.route)calculateRoute();
    else invalidateStaleResults()
  };
  for(const input of[ui.routeFrom,ui.routeTo,ui.avoidSystems,ui.avoidRegions,ui.routeMinSec,ui.routeMaxSec])input.addEventListener("keydown",event=>{if(event.key==="Enter")calculateRoute()})
}
function bindMobileTools(){
  const setOpen=open=>{
    ui.rail.classList.toggle("open",open);
    ui.toolsToggle.setAttribute("aria-expanded",String(open));
    ui.toolsToggle.setAttribute("aria-label",open?"Close navigation and planning tools":"Open navigation and planning tools")
  };
  ui.toolsToggle.onclick=()=>setOpen(!ui.rail.classList.contains("open"));
  ui.map.addEventListener("pointerdown",()=>{if(window.matchMedia("(max-width: 760px)").matches)setOpen(false)});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")setOpen(false)})
}
function bindInspector(){
  ui.inspectorClose.onclick=()=>ui.inspector.classList.remove("open")
}
// --- how wide the region rail is ---------------------------------------------------
//
// A grid column driven by one custom property, which both the shell and the
// topbar read. The map needs no telling: `bindMapResize` below already watches
// the map element with a ResizeObserver and recomputes the camera, and a rail
// drag changes the map's width, so it fires exactly as a window resize does.
//
// Every width goes through `clampRailWidth`, including the one restored from
// storage and the one already applied when the window changes size. A width
// that was reasonable on a wide monitor is not reasonable when the same profile
// opens on a laptop, and nothing about dragging would ever notice.
const PANELS_KEY = STORAGE_KEYS.panels;
let railWidth = RAIL_DEFAULT;

function viewportWidth() {
  return typeof window === "undefined" ? 0 : (window.innerWidth || 0);
}

function applyRailWidth(px, { save = false } = {}) {
  railWidth = clampRailWidth(px, viewportWidth());
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (root && root.style) root.style.setProperty("--rail-width", `${railWidth}px`);
  // Written only when a pilot chose it. Re-clamping on a window resize must not
  // overwrite the width they picked on a bigger screen with the one that fits
  // the small one - the preference is what they asked for, not what fits today.
  if (save) writeJson(localStorage, PANELS_KEY, { railWidth });
  return railWidth;
}

function restoreRailWidth() {
  const saved = readJson(localStorage, PANELS_KEY);
  // `?.` and nothing else: a corrupt preference is handled inside
  // `clampRailWidth`, which treats anything unreadable as the default rather
  // than as a number. A cosmetic setting must never be why a map fails to draw.
  applyRailWidth(saved?.railWidth);
}

// Which element a wheel over the strip should move.
//
// Not `ui.rail` unconditionally. The rail is usually not the scroll container:
// `.region-list` is `flex: 1 1 auto` with its own `overflow-y`, so it shrinks to
// whatever the sections leave and absorbs the overflow - which means the rail
// frequently has nothing to scroll and `rail.scrollTop += delta` moves nothing at all.
//
// A forwarder that silently does nothing is worse than none: it reads as a stuck list
// rather than as a control that was never wired to anything.
//
// So it asks rather than assumes, innermost first, and returns nothing when
// nothing can move - in which case the event is left alone rather than
// swallowed with `preventDefault`.
export function scrollTargetIn(rail) {
  if (!rail) return null;
  const canScroll = el => el && el.scrollHeight > el.clientHeight + 1;
  const list = rail.querySelector?.(".region-list");
  if (canScroll(list)) return list;
  if (canScroll(rail)) return rail;
  return null;
}

function bindRailResize() {
  if (!ui.railResize) return;
  restoreRailWidth();

  // Re-clamped, never re-saved. Making the window smaller must not quietly
  // shrink the stored preference for every window after it.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => applyRailWidth(railWidth));
  }

  const handle = ui.railResize;
  let dragging = null;

  handle.addEventListener("pointerdown", event => {
    // The primary button, and one pointer. Without this a right-click began a
    // resize that followed the mouse - and `preventDefault` below swallowed the
    // context menu on the way - while a second finger started a second drag
    // whose moves fought the first.
    if (event.button !== 0 || event.isPrimary === false) return;
    // The rail's left edge is fixed, so the width is simply the pointer's
    // distance from it. Measured rather than accumulated from deltas, which is
    // what stops the handle drifting away from the cursor over a long drag.
    dragging = { id: event.pointerId };
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add("rail-resizing");
    event.preventDefault();
  });

  handle.addEventListener("pointermove", event => {
    if (!dragging) return;
    const left = ui.rail ? ui.rail.getBoundingClientRect().left : 0;
    applyRailWidth(event.clientX - left);
  });

  const release = event => {
    if (!dragging) return;
    dragging = null;
    handle.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove("rail-resizing");
    // Saved once, at the end. Writing on every pointermove would put a few
    // hundred writes into storage for one drag.
    applyRailWidth(railWidth, { save: true });
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
  // Capture can end without either of those - a window losing focus mid-drag,
  // or the browser taking the gesture back. Without this the drag stayed
  // "active" and `rail-resizing` stayed on the body, so the whole window kept a
  // resize cursor over a drag that had already stopped.
  handle.addEventListener("lostpointercapture", release);

  // A wheel over the strip scrolls the rail, because the strip is in the way of
  // nothing else.
  //
  // It sits at the rail's outer edge now, clear of the scrollbar, so this is
  // belt and braces rather than the fix - but a 6px control beside a scrollbar
  // is 6px a pilot can land on while meaning to scroll, and a wheel that does
  // nothing reads as a stuck list rather than as a missed target. Forwarding
  // costs two lines and removes the question.
  handle.addEventListener("wheel", event => {
    const target = scrollTargetIn(ui.rail);
    if (!target) return;
    target.scrollTop += event.deltaY;
    event.preventDefault();
  }, { passive: false });

  // The escape hatch, for a rail dragged somewhere unhelpful.
  handle.addEventListener("dblclick", () => applyRailWidth(RAIL_DEFAULT, { save: true }));

  // A drag-only control cannot be used without a mouse. Four lines.
  handle.addEventListener("keydown", event => {
    // A drag in progress owns the width; a key pressed mid-drag would fight the
    // pointer for it.
    if (dragging) return;
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") applyRailWidth(railWidth - step, { save: true });
    else if (event.key === "ArrowRight") applyRailWidth(railWidth + step, { save: true });
    else if (event.key === "Home") applyRailWidth(RAIL_DEFAULT, { save: true });
    else return;
    event.preventDefault();
  });
}

function bindMapResize() {
  if (typeof ResizeObserver === "undefined") return;
  new ResizeObserver(() => {
    const rect = ui.map.getBoundingClientRect();
    if (previousMapRect) state.view = resizedCamera(state.view, previousMapRect, rect, state.box);
    previousMapRect = rect;
    applyView();
    }).observe(ui.map);
}
function bind(){
  ui.map.addEventListener("wheel",e=>{e.preventDefault();const p=screenToView(ui.map.getBoundingClientRect(),state.box,e.clientX,e.clientY);zoom(e.deltaY<0?1.12:.89,p.x,p.y)},{passive:false});
  ui.map.addEventListener("pointerdown",e=>{if(e.target.closest(".system-node,.region-node"))return;state.drag={x:e.clientX,y:e.clientY};ui.map.classList.add("dragging");ui.map.setPointerCapture(e.pointerId)});
  ui.map.addEventListener("pointermove",e=>{const r=ui.map.getBoundingClientRect(),p=screenToView(r,state.box,e.clientX,e.clientY);ui.coordinates.textContent=`X ${String(Math.round(p.x)).padStart(3,"0")} · Y ${String(Math.round(p.y)).padStart(3,"0")}`;if(!state.drag)return;const d=screenDeltaToView(r,state.box,e.clientX-state.drag.x,e.clientY-state.drag.y);state.view.x+=d.x;state.view.y+=d.y;state.drag={x:e.clientX,y:e.clientY};applyView()});
  const stop=()=>{
    state.drag=null;
    ui.map.classList.remove("dragging")
  };
  ui.map.onpointerup=stop;
  ui.map.onpointercancel=stop;
  $("zoomIn").onclick=()=>zoom(1.25);
  $("zoomOut").onclick=()=>zoom(.8);
  $("reset").onclick=resetView;
  ui.search.oninput=updateSearch;
  ui.universeTab.onclick=renderUniverse;
  ui.regionTab.onclick=()=>{
    if(!state.region)return;
    state.regionRequestId+=1;
    ui.loading.style.display="none";
    renderRegion(state.selected)
  };
  $("home").onclick=renderUniverse;
  document.addEventListener("keydown",e=>{if(e.key==="/"&&document.activeElement!==ui.search){e.preventDefault();ui.search.focus()}if(e.key==="Escape"){ui.results.hidden=true;ui.inspector.classList.remove("open")}})
}
// The shape of data/eve_map_all.json this code is written against. The archive
// carries the same number, and the builder bumps it when the export shape
// changes.
//
// This exists because the two halves are cached independently. A browser
// holding yesterday's app.js will happily load today's freshly rebuilt archive,
// and the result is not a clean failure - it is a map that mostly works with
// one field missing, which is far harder to diagnose than an error. A stale
// viewer now says so and says what to do about it.
const ARCHIVE_SCHEMA=5;
function checkArchiveSchema(atlas){
  const found=atlas?.meta?.schema_version;
  if(found===ARCHIVE_SCHEMA)return true;
  const stale=typeof found==="number"&&found>ARCHIVE_SCHEMA;
  ui.eyebrow.textContent="LOCAL SESSION / VERSION MISMATCH";
  ui.title.textContent=stale?"Reload to update the viewer":"Rebuild the archive";
  const detail=stale?`The map data is version ${found} and this page is version ${ARCHIVE_SCHEMA}. The browser is running a cached copy of an older viewer. Reload the page, bypassing the cache, to pick up the current one.`:`This page expects map data version ${ARCHIVE_SCHEMA} and found ${found===undefined?"none":found}. Run python scripts/build_offline_map.py to regenerate the archive.`;
  display(`<div class="inspector-header"><span class="inspector-tag">Version mismatch</span><h2>${stale?"Cached viewer":"Old archive"}</h2><p>${esc(detail)}</p></div>`, "mismatch");
  console.warn(`archive schema ${found}, viewer expects ${ARCHIVE_SCHEMA}`);
  return false
}
// Attached once, however many times init runs.
//
// Twenty-five of the binds below use addEventListener, which appends: a second
// init would leave every change handler firing twice, a third three times. In
// the browser init runs once and this could not happen - but it is exported so
// a reload path or a test can call it again, and an export is a promise that
// calling it is safe. The one timer in the application is guarded the same way.
let bindingsAttached = false;

async function init(){
  if(!bindingsAttached){
    bind();
    bindLayout();
    bindSovereignty();
    bindAmbient();
    bindScout();
    bindLive();
    bindBridges();
    bindAvoidToggle();
    bindThreat();
    restoreThreatSettings();
    bindPanelRead();
    restorePanelReadSetting();
    bindMobileTools();
    bindInspector();
    bindRoutePlanner();
    bindCorridors();
    bindTactical();
    bindJump();
    bindHistory();
    bindVault();
    bindRailResize();
    bindAsk();
    bindingsAttached=true
  }
  // Two failures, told apart.
  //
  // One catch covered both fetching the archive and everything done with it
  // afterwards, and reported all of it as "Archive unavailable / Open the atlas
  // through its local web server". That is right for a missing file and wrong
  // for anything else: a rendering fault in renderUniverse, or a throw building
  // the tactical index, sends the pilot to check a web server that was
  // working. The two need different words because they need different actions.
  let index;
  let atlas;
  try{
    ({index,atlas}=await loadAtlas())
  }catch(e){
    ui.title.textContent="Archive unavailable";
    ui.eyebrow.textContent="LOCAL SERVER REQUIRED";
    ui.empty.innerHTML="<h2>Map data could not be read</h2><p>Open the atlas through its local web server.</p>";
    console.error(e);
    ui.loading.style.display="none";
    return
  }
  try{
    state.index=index;
    state.atlas=atlas;
    if(!checkArchiveSchema(atlas))return;
    state.routePlanner=new RoutePlanner(atlas);
    // The stored bridges were read before there was a planner to resolve them
    // against, and the avoid list needs the atlas to turn ids into names.
    refreshBridges();
    // The wormhole layer for the same reason, and more urgently: with no atlas
    // every system looks unconnected, so restoreLive() concluded that open,
    // usable holes were "outside the supported routing network" and said so
    // next to an age reading "synced just now". Unknown, presented as a
    // definite negative, until the thirty-second tick happened to repair it.
    refreshScout();
    refreshAvoid();
    try{
      state.jumpPlanner=new JumpPlanner(atlas,await loadShips());
      populateShips();
      populateModules();
      restoreJumpSettings();
      describeShipFuel()
    }catch(error){
      ui.jumpError.textContent="Ship data unavailable; capital jump planning is disabled.";
      console.error(error)
    }
    state.tacticalAnalyzer=new TacticalAnalyzer(atlas);
    renderRegionList();
    renderUniverse()
  }catch(e){
    // The archive was read. Something after it failed, and saying the data is
    // missing would send the pilot to fix the one thing that is working.
    ui.title.textContent="The map could not be drawn";
    ui.eyebrow.textContent="LOCAL SESSION / DRAW FAILED";
    ui.empty.innerHTML="<h2>The archive loaded but the map could not be drawn</h2>"
      +"<p>This is a fault in the viewer rather than in the data. The console carries the detail.</p>";
    console.error(e)
  }finally{
    ui.loading.style.display="none"
  }
}
// The module's side effect belongs to the browser. Under a test harness the
// internals below are imported directly, and init() would only fail on fetch.
if(typeof window!=="undefined"){
  // `init` handles what it expects - a missing archive, a map that will not draw -
  // and a throw past those arms had nowhere to go, leaving a half-started
  // application and an empty console. This is the last of the three.
  init().catch(error => {
    ui.title.textContent="Startup failed";
    ui.empty.innerHTML="<h2>The atlas could not start</h2><p>Reload the page. If it persists, the console has the reason.</p>";
    ui.loading.style.display="none";
    console.error("startup", error)
  });
  bindMapResize()
}
export{
  state,ui,legend,planJump,toggleRangeRings,clearRangeRings,showRange,describeShipFuel,
  populateModules,showJump,populateShips,restoreJumpSettings,saveJumpSettings,bindJump,
  buildRouteIndex,styleGateEdges,renderOverlay,clearRoute,calculateRoute,refreshAvoid,
  addAvoidSystem,saveRouteSettings,restoreRouteSettings,renderCorridors,saveCorridor,
  loadCorridor,dropCorridor,bindCorridors,exportCorridors,importCorridors,corridorDetail,
  selectSystem,showSystem,renderUniverse,renderRegion,zoom,resetView,applyView,
  invalidateStaleResults,clearRouteResult,clearJumpResult,jumpValues,routeValues,
  addBridge,dropBridge,refreshBridges,renderBridges,bindBridges,bridgeEntries,routableBridges,routingSource,
  renderAvoidList,avoidListEntries,ignoreSystem,overrideLabel,markAvoided,standingAvoidance,
  avoidanceApplied,setAvoidance,bindAvoidToggle,appliedOverrides,
  runThreat,clearThreat,renderThreatClasses,bindThreat,markThreat,saveThreatSettings,restoreThreatSettings,threatsToSystem,
  buildHeat,laneFor,
  syncAmbient,bindAmbient,renderAmbientStatus,ambientKnown,ambientOf,markAmbient,
  syncActivityLayer,renderActivityStatus,activityKnown,heatIn,syncLive,bindLive,
  syncCampaignLayer,renderCampaignStatus,campaignsKnown,campaignsFor,markCampaigns,
  syncScoutLayer,refreshScout,renderScoutList,scoutEnabled,scoutKnown,scoutSignatures,routingNetwork,bindScout,
  bindVault,refreshVault,renderVault,addCharacter,forgetCharacter,
  callCore,sendCore,sendAdvisor,reason,CORE_COMMANDS,ADVISOR_COMMANDS,DARK_OPS,
  applyRailWidth,restoreRailWidth,bindRailResize,
  readLiveSave,commitLiveSave,renderLiveSave,
  onGateGraph,flushLiveWrites,liveTimeText,renderLiveAges,tickLiveTimes,refreshOpenInspector,liveSyncAllowed,init,bindHistory,clearHistory,disarmHistory,renderHistoryCount,historyCutoff,
  exportHistory,importHistoryFile,historyCutoffArmed,
  bindRoutePlanner,setLayoutMode,renderLayoutBar,bindLayout,bindSovereignty,syncSov,renderSovereigntyStatus,sovHolderOf,sovereigntyKnown,restoreLive,persistLive,checkArchiveSchema,ARCHIVE_SCHEMA,
  showRoute,showRegion,showTacticalBrief,runTacticalBrief,clearBrief,plannerInputs,
  mintBriefSnapshot,openAsk,closeAsk,renderAskWindows,renderAskOpener,askAvailable,submitAsk,setAskTransport,
  refreshAdvisorAvailability,advisorTurn,
  readOn,storedReadOn,briefKey,requestPanelRead,renderPanelRead,clearPanelRead,bindPanelRead,savePanelReadSetting,restorePanelReadSetting
};
