// ESMI Inspect: parts inventory. Lists the boat's parts in groups; each can be added to or
// removed from the model (so the boat can be built up part by part) and repainted from a
// marine palette or a custom colour. Choices are kept in localStorage.
//
// Parts are the model's top-level nodes, named "esmi part <id>" in Blender (three.js turns
// the spaces into underscores). Each paint clones its material for that group only, so
// repainting the railings leaves the canopy posts, which share the aluminium, unchanged.

const STORE = 'esmi-inspect-inventory-v1';

const PALETTE = [
  ['White', '#f3f4f5'], ['Silver', '#c3c7cc'], ['Graphite', '#3a3d42'], ['Black', '#1b1d20'],
  ['Navy', '#1d3a5f'], ['ESMI teal', '#31adb5'], ['Ocean blue', '#2f7fb3'], ['Red', '#c43c32'],
  ['Sand', '#d8c7a3'], ['Forest', '#3e6b4f'],
];
// The solar texture is multiplied by its colour, so it gets tints rather than paints.
const SOLAR_TINTS = [['Classic blue', '#ffffff'], ['Deep navy', '#8a93b8'], ['All black', '#3a3a3e']];

const ITEMS = [
  { id: 'hulls', name: 'Twin hulls', note: 'Port and starboard pontoons', parts: /^(port|starboard)-/, paints: [
    { id: 'topsides', name: 'Topsides', materials: ['hull silver'] },
    { id: 'keels', name: 'Keels', materials: ['hull charcoal'] } ] },
  { id: 'crossbeams', name: 'Crossbeams', note: 'Aluminium cross-structure', parts: /^crossbeam/, paints: [{ id: 'beams', name: 'Beams', materials: ['beam'] }] },
  { id: 'deck', name: 'Deck', note: 'Non-slip deck panels', parts: /^deck-/, paints: [{ id: 'deck', name: 'Deck', materials: ['deck'] }],
    variants: [{ id: 'standard', name: 'Standard' }, { id: 'wide', name: 'Wide ×1.5' }] },
  { id: 'railings', name: 'Railings', note: 'Rails, posts and corners', parts: /^rail-/, paints: [{ id: 'rails', name: 'Rails', materials: ['brushed aluminium'] }] },
  { id: 'seats', name: 'Seats', note: 'Four bucket seats', parts: /^seat/, paints: [
    { id: 'cushions', name: 'Cushions', materials: ['seat cushion'] },
    { id: 'shells', name: 'Shells', materials: ['seat shell'] } ] },
  { id: 'helm', name: 'Helm console', note: 'Console, wheel and screen', parts: /^(console|helm-column|steering-wheel|windscreen)$/, paints: [
    { id: 'console', name: 'Console', materials: ['console gelcoat'] },
    { id: 'wheel', name: 'Wheel', materials: ['wheel'] } ] },
  { id: 'canopy', name: 'Canopy frame', note: 'Uprights and roof frame', parts: /^(upright|roof-|canopy-edge)/, paints: [{ id: 'frame', name: 'Frame', materials: ['brushed aluminium', 'solar frame'] }] },
  { id: 'solar', name: 'Solar panels', note: 'Twelve PV modules', parts: /^solar-module/, paints: [{ id: 'cells', name: 'Cells', materials: ['solar cells web'], tints: true }] },
  { id: 'drive', name: 'Electric drive', note: 'Pod motor and propeller', parts: /^(drive-|propeller)/, paints: [{ id: 'motor', name: 'Motor', materials: ['outboard'] }] },
  { id: 'batteries', name: 'Battery pack', note: 'Eight modules and BMS', parts: /^(battery-|bms|busbar|distribution-box)/, paints: [{ id: 'cells', name: 'Modules', materials: ['battery'] }] },
  { id: 'wiring', name: 'Wiring & controls', note: 'Cable looms and controllers', parts: /^(cable|motor-controller|solar-charger)/, paints: [] },
];

const partId = node => node.name.replace(/^esmi[_ ]part[_ ]/, '').replace(/_/g, ' ');
const hex = color => '#' + color.getHexString();

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save(state) {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {}
}

// Added parts pop in from slightly smaller (the model animates position and rotation only,
// so scale is free to use).
function pop(nodes, reduced) {
  if (reduced) return;
  const start = performance.now(), duration = 420;
  const back = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
  const step = now => {
    const k = Math.min(1, (now - start) / duration), s = .55 + .45 * back(k);
    nodes.forEach(n => n.scale.set(s, s, s * (n.userData.baseZ || 1)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Wide ×1.5: the whole boat gets one and a half times the beam. Positions across the boat
// (three's z) are remapped: inside the standard deck (|z| < 0.87 m) everything spreads out
// ×1.5, and from the hulls outward everything moves out by 0.435 m, so both regions meet at
// the new deck edge (2.6 m across instead of 1.74 m). Seats, the helm and the hulls keep their
// size and move; cross-boat structure (deck, beams, bow and stern rails, roof bars, canopy,
// battery tray, wiring) stretches to the new width. Each seat row gains a middle seat, for six.
// Moves are added to each part's position track, so they also hold while the boat is pulled
// apart; stretching uses the part's z scale, which the animation leaves alone.
const DECK_HALF = .87, WIDEN = 1.5;
export const widenZ = z => Math.abs(z) < DECK_HALF ? z * WIDEN : z + Math.sign(z) * DECK_HALF * (WIDEN - 1);
const STRETCH = /^(deck-|crossbeam|rail-(bow|stern)$|roof-bar|canopy-edge|solar-module|battery-tray|busbar|cable)/;
const unitOf = id => /^(console|helm-column|steering-wheel|windscreen)$/.test(id) ? 'helm' : (id.match(/^seat-(\d)/) || [])[1] !== undefined ? 'seat' + id.match(/^seat-(\d)/)[1] : id;

function planWidth(model, Box3) {
  const units = new Map();
  for (const node of model.children) {
    const box = new Box3().setFromObject(node);
    node.userData.zBox = [box.min.z, box.max.z];
    const unit = unitOf(partId(node));
    const u = units.get(unit) || [Infinity, -Infinity];
    units.set(unit, [Math.min(u[0], box.min.z), Math.max(u[1], box.max.z)]);
  }
  for (const node of model.children) {
    const id = partId(node), [z0, z1] = node.userData.zBox;
    if (STRETCH.test(id) && z1 - z0 > 1e-3) {
      const p = node.position.z, s = (widenZ(z1) - widenZ(z0)) / (z1 - z0);
      node.userData.widen = { s, t: widenZ(z0) - (p + (z0 - p) * s) };
    } else {
      const [u0, u1] = units.get(unitOf(id)), c = (u0 + u1) / 2;
      node.userData.widen = { s: 1, t: widenZ(c) - c };
    }
  }
}

// The middle seat of each row (wide boat only) copies a seat in that row: each of its parts
// (base, pan, arms, back, cushion) is cloned and hung under the original part, offset to the
// centreline, so it shares paint and follows the original when the boat is pulled apart.
const MIDDLE_SEATS = ['seat-2', 'seat-0'];          // front row (starboard), back row (starboard)
function addMiddleSeats(model) {
  for (const source of MIDDLE_SEATS) {
    const unit = model.children.filter(n => partId(n) === source || partId(n).startsWith(source + '-'));
    if (!unit.length) continue;
    const z0 = Math.min(...unit.map(n => n.userData.zBox[0])), z1 = Math.max(...unit.map(n => n.userData.zBox[1]));
    const offset = -widenZ((z0 + z1) / 2);
    for (const node of unit) {
      const copy = node.clone(false);
      copy.name = ''; copy.position.set(0, 0, offset); copy.quaternion.identity(); copy.scale.setScalar(1);
      node.children.forEach(child => copy.add(child.clone()));
      copy.visible = false;
      node.add(copy);
      node.userData.middleSeat = copy;
    }
  }
}

function setWidth(model, clips, wide) {
  if (Boolean(model.userData.wide) === wide) return;
  model.userData.wide = wide;
  const sign = wide ? 1 : -1;
  for (const node of model.children) {
    const w = node.userData.widen;
    if (!w) continue;
    for (const clip of clips) for (const track of clip.tracks) {
      if (track.name !== `${node.name}.position`) continue;
      for (let i = 2; i < track.values.length; i += 3) track.values[i] += sign * w.t;
    }
    node.userData.baseZ = wide ? w.s : 1;
    node.scale.set(1, 1, node.userData.baseZ);
    if (node.userData.middleSeat) node.userData.middleSeat.visible = wide;
  }
}

export function setupInventory(model, { reduced = false, preview = null, clips = [], Box3 = null, onLayout = null, part = null, onFocus = null } = {}) {
  const panel = document.querySelector('.ins-inventory');
  if (!panel) return;
  const list = panel.querySelector('.ins-inv-list');
  const count = panel.querySelector('.ins-inv-count');
  const state = load();
  state.hidden ??= {}; state.colors ??= {}; state.variants ??= {};

  // Sort the model's parts into the inventory items, cloning each paint's materials.
  const items = ITEMS.map(item => ({ ...item, nodes: [], paints: item.paints.map(p => ({ ...p, clones: [], original: null })) }));
  for (const node of model.children) {
    const id = partId(node);
    const item = items.find(it => it.parts.test(id));
    if (!item) continue;
    item.nodes.push(node);
    node.traverse(mesh => {
      if (!mesh.isMesh) return;
      const swap = m => {
        const name = (m.name || '').replace(/^esmi /, '');
        const paint = item.paints.find(p => p.materials.includes(name));
        if (!paint) return m;
        let clone = paint.clones.find(c => c.userData.source === m);
        if (!clone) { clone = m.clone(); clone.userData.source = m; clone.userData.original = hex(m.color); paint.clones.push(clone); paint.original ??= hex(m.color); }
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }
  const live = items.filter(it => it.nodes.length);
  if (Box3) { planWidth(model, Box3); addMiddleSeats(model); }

  const paintKey = (item, paint) => `${item.id}.${paint.id}`;
  const updateSeatsNote = () => {
    const note = list.querySelector('[data-item="seats"] .ins-inv-note');
    if (note) note.textContent = model.userData.wide ? 'Six seats, 3 front + 3 back' : 'Four bucket seats';
  };
  // Previews are redrawn after colour changes, at most once per frame.
  const stale = new Set();
  let refresh = 0;
  const refreshPreview = item => {
    if (!preview) return;
    stale.add(item);
    refresh ||= requestAnimationFrame(() => {
      refresh = 0;
      for (const it of stale) if (it.thumb) it.thumb.src = preview(it.nodes);
      stale.clear();
    });
  };
  const setColor = (item, paint, value) => {
    const original = value.toLowerCase() === paint.original;
    paint.clones.forEach(m => m.color.set(original ? m.userData.original : value));
    const key = paintKey(item, paint);
    if (value.toLowerCase() === paint.original) delete state.colors[key]; else state.colors[key] = value;
    refreshPreview(item);
  };
  const updateCount = () => {
    const shown = live.filter(it => !state.hidden[it.id]).length;
    count.textContent = `${shown}/${live.length}`;
  };
  const setShown = (item, shown, animate = true) => {
    const was = item.nodes[0].visible;
    item.nodes.forEach(n => { n.visible = shown; n.scale.set(1, 1, n.userData.baseZ || 1); });
    if (shown) delete state.hidden[item.id]; else state.hidden[item.id] = true;
    if (shown && !was && animate) pop(item.nodes, reduced);
    const box = list.querySelector(`[data-item="${item.id}"] input[type="checkbox"]`);
    if (box) box.checked = shown;
    list.querySelector(`[data-item="${item.id}"]`)?.classList.toggle('is-off', !shown);
    updateCount();
  };

  // Build the list.
  list.textContent = '';
  for (const item of live) {
    const li = document.createElement('li');
    li.className = 'ins-inv-item'; li.dataset.item = item.id;
    const row = document.createElement('div'); row.className = 'ins-inv-row';
    // The whole tile (preview, name, note) is the checkbox's label.
    const label = document.createElement('label'); label.className = 'ins-inv-name';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true;
    box.setAttribute('aria-label', `Show ${item.name}`);
    const thumb = document.createElement('span'); thumb.className = 'ins-inv-thumb';
    const img = document.createElement('img'); img.alt = ''; img.decoding = 'async';
    const tick = document.createElement('span'); tick.className = 'ins-inv-check'; tick.setAttribute('aria-hidden', 'true');
    thumb.append(img, tick);
    const text = document.createElement('span'); text.className = 'ins-inv-text';
    const title = document.createElement('span'); title.className = 'ins-inv-title'; title.textContent = item.name;
    const note = document.createElement('span'); note.className = 'ins-inv-note'; note.textContent = item.note || '';
    text.append(title, note);
    label.append(box, thumb, text);
    item.thumb = img;
    box.addEventListener('change', () => { setShown(item, box.checked); save(state); });
    const swatches = document.createElement('div'); swatches.className = 'ins-inv-swatches';
    row.append(label, swatches);
    li.append(row);

    for (const paint of item.paints) {
      if (!paint.clones.length) continue;
      const current = state.colors[paintKey(item, paint)] || paint.original;
      const sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'ins-inv-swatch';
      sw.style.setProperty('--c', paint.tints ? (current === '#ffffff' ? '#24356b' : current) : current);
      sw.setAttribute('aria-label', `${item.name}: ${paint.name.toLowerCase()} colour`);
      sw.setAttribute('aria-expanded', 'false');
      sw.title = paint.name;
      swatches.append(sw);

      const palette = document.createElement('div'); palette.className = 'ins-inv-palette'; palette.hidden = true;
      const heading = document.createElement('p'); heading.className = 'ins-inv-palette-title'; heading.textContent = paint.name;
      const grid = document.createElement('div'); grid.className = 'ins-inv-colors';
      const choose = value => {
        setColor(item, paint, value);
        sw.style.setProperty('--c', paint.tints ? (value === '#ffffff' ? '#24356b' : value) : value);
        grid.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === value.toLowerCase())));
        if (picker) picker.value = value;
        save(state);
      };
      const options = paint.tints ? SOLAR_TINTS : [['Original', paint.original], ...PALETTE.filter(([, v]) => v !== paint.original)];
      for (const [name, value] of options) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ins-inv-color'; b.dataset.color = value.toLowerCase();
        b.style.setProperty('--c', paint.tints && value === '#ffffff' ? '#24356b' : value);
        b.title = name; b.setAttribute('aria-label', name);
        b.setAttribute('aria-pressed', String(value.toLowerCase() === current.toLowerCase()));
        b.addEventListener('click', () => choose(value.toLowerCase()));
        grid.append(b);
      }
      let picker = null;
      if (!paint.tints) {
        const custom = document.createElement('label'); custom.className = 'ins-inv-custom'; custom.title = 'Custom colour';
        picker = document.createElement('input'); picker.type = 'color'; picker.value = current;
        picker.setAttribute('aria-label', `Custom ${paint.name.toLowerCase()} colour`);
        picker.addEventListener('input', () => choose(picker.value.toLowerCase()));
        custom.append(picker);
        grid.append(custom);
      }
      palette.append(heading, grid);
      li.append(palette);

      sw.addEventListener('click', () => {
        const opening = palette.hidden;
        list.querySelectorAll('.ins-inv-palette').forEach(p => { p.hidden = true; });
        list.querySelectorAll('.ins-inv-swatch').forEach(s => s.setAttribute('aria-expanded', 'false'));
        palette.hidden = !opening;
        sw.setAttribute('aria-expanded', String(opening));
      });
      if (current !== paint.original) setColor(item, paint, current);
    }
    if (item.variants) {
      const group = document.createElement('div');
      group.className = 'ins-inv-variants'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Boat width');
      const current = state.variants[item.id] || item.variants[0].id;
      const select = (id, animate) => {
        const wide = id === 'wide';
        const changed = Boolean(model.userData.wide) !== wide;
        setWidth(model, clips, wide);
        if (id === item.variants[0].id) delete state.variants[item.id]; else state.variants[item.id] = id;
        group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.variant === id)));
        updateSeatsNote();
        if (!changed) return;
        if (animate) pop(model.children.filter(n => n.visible), reduced);
        live.forEach(refreshPreview);
        onLayout?.(wide, animate);
      };
      for (const variant of item.variants) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ins-inv-variant'; b.dataset.variant = variant.id; b.textContent = variant.name;
        b.addEventListener('click', () => { select(variant.id, true); save(state); });
        group.append(b);
      }
      li.insertBefore(group, row.nextSibling);
      select(current, false);
    }
    list.append(li);
    setShown(item, !state.hidden[item.id], false);
  }

  updateSeatsNote();
  live.forEach(refreshPreview);

  panel.querySelector('[data-inv="all"]').addEventListener('click', () => { live.forEach(it => setShown(it, true)); save(state); });
  panel.querySelector('[data-inv="none"]').addEventListener('click', () => { live.forEach(it => setShown(it, false)); save(state); });
  panel.querySelector('[data-inv="colors"]').addEventListener('click', () => {
    for (const item of live) for (const paint of item.paints) {
      if (!paint.clones.length) continue;
      setColor(item, paint, paint.original);
      const li = list.querySelector(`[data-item="${item.id}"]`);
      const index = item.paints.filter(p => p.clones.length).indexOf(paint);
      li.querySelectorAll('.ins-inv-swatch')[index]?.style.setProperty('--c', paint.tints ? '#24356b' : paint.original);
      li.querySelectorAll('.ins-inv-palette')[index]?.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === paint.original)));
      const picker = li.querySelectorAll('.ins-inv-palette')[index]?.querySelector('input[type="color"]');
      if (picker) picker.value = paint.original;
    }
    save(state);
  });

  // Open by default where there is room beside the boat; a pill on smaller screens.
  const toggle = panel.querySelector('.ins-inv-toggle');
  const setOpen = open => { panel.dataset.open = String(open); toggle.setAttribute('aria-expanded', String(open)); };
  setOpen(innerWidth >= 1100);
  toggle.addEventListener('click', () => setOpen(panel.dataset.open !== 'true'));
  panel.hidden = false;

  // Customizer (inspect.html?part=<id>, opened from the part cards): only that part is shown
  // and the panel holds just its colours and options, with previous / next to step through
  // the parts. Nothing here is saved as hidden, so the full boat is unaffected; colours are
  // the same saved choices, so they carry over to the boat.
  const start = live.findIndex(it => it.id === part);
  if (part && start >= 0) {
    panel.classList.add('is-customizer');
    list.querySelectorAll('.ins-inv-name input').forEach(box => { box.disabled = true; });
    toggle.querySelector('span').textContent = 'Customize';
    panel.querySelector('.ins-inv-hint').textContent = 'Pick a colour for each finish. Your choices also show on the full boat.';
    const nav = document.createElement('div');
    nav.className = 'ins-inv-steps';
    nav.innerHTML = `<button type="button" data-step="-1" aria-label="Previous part">← Prev</button>
      <a class="ins-inv-allparts" href="./#parts">All parts</a>
      <button type="button" data-step="1" aria-label="Next part">Next →</button>`;
    panel.querySelector('.ins-inv-actions').replaceWith(nav);
    const actions = document.createElement('div');
    actions.className = 'ins-inv-actions';
    actions.innerHTML = '<a class="ins-inv-onboat" href="./inspect.html">See it on the boat</a><button type="button" data-inv="colors-part">Reset colours</button>';
    panel.querySelector('.ins-inv-body').append(actions);
    let index = start;
    const focus = (i, animate) => {
      index = (i + live.length) % live.length;
      const item = live[index];
      for (const it of live) {
        it.nodes.forEach(n => { n.visible = it === item; n.scale.set(1, 1, n.userData.baseZ || 1); });
        const li = list.querySelector(`[data-item="${it.id}"]`);
        li.hidden = it !== item;
        li.querySelectorAll('.ins-inv-palette').forEach(p => { p.hidden = it !== item; });
        li.querySelectorAll('.ins-inv-swatch').forEach(sw => sw.setAttribute('aria-expanded', String(it === item)));
      }
      if (animate) pop(item.nodes, reduced);
      count.textContent = `${String(index + 1).padStart(2, '0')} / ${live.length}`;
      history.replaceState(null, '', `?part=${item.id}`);
      const note = list.querySelector(`[data-item="${item.id}"] .ins-inv-note`)?.textContent || item.note;
      onFocus?.(item.nodes, { id: item.id, name: item.name, note, number: index + 1, total: live.length }, animate);
    };
    nav.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => focus(index + Number(b.dataset.step), true)));
    actions.querySelector('button').addEventListener('click', () => {
      const li = list.querySelector(`[data-item="${live[index].id}"]`);
      for (const paint of live[index].paints) {
        if (!paint.clones.length) continue;
        li.querySelector(`.ins-inv-palette [data-color="${paint.original}"]`)?.click();
      }
    });
    // The width switch changes the whole boat; keep only the focused part on show afterwards.
    const relayout = onLayout;
    onLayout = (wide, animate) => { relayout?.(wide, animate); focus(index, false); };
    setOpen(true);
    focus(index, false);
  }
}
