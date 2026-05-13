/* =================================================================
   Whispering Hollows — game.js
   A vanilla-JS D&D-lite adventure that intentionally exercises a wide
   spread of JavaScript concepts:
     • ES modules-as-IIFE pattern, strict mode
     • Classes, static methods, private-ish fields via _underscore
     • Closures (event delegation, factory functions)
     • async / await + fetch + Promise.race for timeouts
     • Destructuring, spread / rest, template literals, optional chaining
     • Array methods: map / filter / reduce / find / some / every / flat
     • localStorage persistence
     • Math.random dice with weighted modifiers
     • setTimeout chains for theatrical animations
     • Custom events on a tiny pub/sub bus
   ================================================================= */
'use strict';

(() => {

// ===================================================================
// 1. DATA — themes, riddle bank, helpers
// ===================================================================

const THEMES = [
  { id:'whimsical', icon:'✿', title:'Whimsical',  blurb:'Talking mushrooms, polite ghosts.' },
  { id:'rainy',     icon:'☂', title:'Rainy',      blurb:'Soft drizzle, glowing lanterns.'   },
  { id:'thrill',    icon:'⚡', title:'Thrill',     blurb:'Cliff edges, narrow escapes.'      },
  { id:'horror',    icon:'☾', title:'Horror',     blurb:'A draft you cannot place.'         },
  { id:'mystic',    icon:'❋', title:'Mystic',     blurb:'Stars hum back at you.'            },
];

const ELEMENT_BONUS = { fire:6, ice:5, light:5, shadow:6, nature:4 };
const WEAKNESS_PAIR = { fire:'ice', ice:'fire', light:'shadow', shadow:'light', nature:'fire' };

// Curated riddle bank — used as fallback if API is unreachable
const RIDDLE_BANK = [
  { q:'I speak without a mouth and hear without ears. I have no body, but I come alive with the wind. What am I?', a:'echo' },
  { q:'The more you take, the more you leave behind. What are they?', a:'footsteps' },
  { q:'I have cities but no houses, mountains but no trees, water but no fish. What am I?', a:'a map' },
  { q:'What has keys but no locks, space but no rooms, and lets you enter but not go in?', a:'keyboard' },
  { q:'I’m tall when I’m young, and short when I’m old. What am I?', a:'candle' },
  { q:'What has hands but cannot clap?', a:'clock' },
  { q:'I have a tail and a head but no body. What am I?', a:'coin' },
  { q:'What gets wetter the more it dries?', a:'towel' },
  { q:'What can travel around the world while staying in the corner?', a:'stamp' },
  { q:'I’m light as a feather, yet the strongest person can’t hold me for five minutes. What am I?', a:'breath' },
  { q:'You see me once in June, twice in November, but not at all in May. What am I?', a:'letter e' },
  { q:'What has many teeth but cannot bite?', a:'comb' },
];

// pick a random item — closure produces a never-repeating sequence
const makeShuffler = (list) => {
  const remaining = [...list];
  return () => {
    if (remaining.length === 0) remaining.push(...list);
    const i = Math.floor(Math.random() * remaining.length);
    return remaining.splice(i, 1)[0];
  };
};
const nextLocalRiddle = makeShuffler(RIDDLE_BANK);

// fetch a riddle from public API, with timeout + fallback
async function fetchRiddle(){
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch('https://riddles-api.vercel.app/random', { signal: controller.signal });
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    const q = data.riddle || data.question;
    const a = (data.answer || '').toLowerCase().trim();
    if (!q || !a) throw new Error('bad payload');
    // reject overly long riddles — they break the modal & take forever to read
    if (q.length > 220) throw new Error('too long');
    return { q, a, source:'api' };
  } catch (_e) {
    const { q, a } = nextLocalRiddle();
    return { q, a, source:'bank' };
  } finally {
    clearTimeout(timeout);
  }
}

// loose answer match (lowercase, strip articles + punctuation)
function answerMatches(expected, given){
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\b(a|an|the)\b/g,'').replace(/\s+/g,' ').trim();
  const ex = norm(expected);
  const gv = norm(given);
  if (!gv) return false;
  return ex === gv || ex.includes(gv) || gv.includes(ex);
}

// dice
const rollDie = (sides) => 1 + Math.floor(Math.random() * sides);

// tiny pub/sub bus
const bus = (() => {
  const subs = {};
  return {
    on:  (ev, fn) => { (subs[ev] = subs[ev] || []).push(fn); },
    emit:(ev, payload) => { (subs[ev] || []).forEach(fn => fn(payload)); },
  };
})();

// ===================================================================
// 2. MODELS — Character + Game state
// ===================================================================

class Character {
  constructor({ name, kind, hat, cloak, weapon, eyes, strength, weakness, role }){
    this.id = 'c_' + Math.random().toString(36).slice(2,9);
    this.name = name; this.kind = kind;
    this.hat = hat; this.cloak = cloak; this.weapon = weapon; this.eyes = eyes;
    this.strength = strength; this.weakness = weakness; this.role = role;
    // ?fast=1 in the URL gives a fast-resolving demo (25 HP instead of 100)
    const fast = new URLSearchParams(location.search).get('fast') === '1';
    this.hp = fast ? 25 : 100; this.maxHp = this.hp;
    this.alive = true;
  }
  get isAlive(){ return this.hp > 0 }
  takeDamage(amount){
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) this.alive = false;
    return this.hp;
  }
  // returns the elemental attack bonus, factoring opponent weakness
  attackBonusVs(target){
    let bonus = ELEMENT_BONUS[this.strength] ?? 4;
    if (WEAKNESS_PAIR[target.strength] === this.strength) bonus += 4; // type advantage
    return bonus;
  }
}

const Game = {
  phase:'welcome',        // welcome | creator | theme | play | credits
  dmName:'',
  party:[],               // Character[]
  playerCount:3,
  creatorIndex:0,
  theme:null,
  turnIndex:0,
  log:[],
  pendingRiddle:null,
  reset(){
    Object.assign(this, { phase:'welcome', dmName:'', party:[], playerCount:3, creatorIndex:0, theme:null, turnIndex:0, log:[], pendingRiddle:null });
    localStorage.removeItem('wh-game');
  },
  save(){ localStorage.setItem('wh-game', JSON.stringify({ phase:this.phase, dmName:this.dmName, party:this.party, theme:this.theme, turnIndex:this.turnIndex, log:this.log })); },
};

// ===================================================================
// 3. VIEW HELPERS
// ===================================================================

const app = document.getElementById('app');
const phasePill = document.getElementById('phase-pill');
const resetBtn  = document.getElementById('reset-btn');

resetBtn.addEventListener('click', () => {
  if (!confirm('Start a fresh tale? Current heroes will be forgotten.')) return;
  Game.reset();
  bus.emit('phase', 'welcome');
});

function setPhase(name){
  Game.phase = name;
  const labels = { welcome:'Setup', creator:'Forging Heroes', theme:'Choosing Mood', play:'In the Tale', credits:'Credits' };
  phasePill.textContent = labels[name];
  bus.emit('phase', name);
}

function clone(tplId){
  const tpl = document.getElementById(tplId);
  return tpl.content.firstElementChild.cloneNode(true);
}

function mount(node){
  app.innerHTML = '';
  app.appendChild(node);
}

// build a mini avatar inline-element for use in rails / party chips
function buildMiniAvatar(c, size = 46){
  const wrap = document.createElement('div');
  wrap.className = 'mini-avatar';
  wrap.style.width = size + 'px';
  wrap.style.height = size + 'px';
  wrap.dataset.cloak = c.cloak;
  wrap.innerHTML = `
    <div class="m-hat"></div>
    <div class="m-head"></div>
    <div class="m-eye l"></div>
    <div class="m-eye r"></div>
    <div class="m-cloak"></div>`;
  return wrap;
}

// ===================================================================
// 4. RENDERERS PER PHASE
// ===================================================================

// -------- 4a. Welcome --------
function renderWelcome(){
  const node = clone('tpl-welcome');
  const cInp = node.querySelector('#player-count');
  const dInp = node.querySelector('#dm-name');
  cInp.value = Game.playerCount;
  dInp.value = Game.dmName;
  node.querySelector('#begin-creation-btn').addEventListener('click', () => {
    const n = Math.max(1, Math.min(6, parseInt(cInp.value, 10) || 1));
    Game.playerCount = n;
    Game.dmName = dInp.value.trim() || 'The Master';
    Game.party = [];
    Game.creatorIndex = 0;
    setPhase('creator');
  });
  mount(node);
}

// -------- 4b. Creator --------
function renderCreator(){
  const node = clone('tpl-creator');
  node.querySelector('[data-slot="idx"]').textContent  = Game.creatorIndex + 1;
  node.querySelector('[data-slot="total"]').textContent = Game.playerCount;

  const form   = node.querySelector('#creator-form');
  const avatar = node.querySelector('#live-avatar');

  // live preview using event delegation on the form
  const updatePreview = () => {
    const data = new FormData(form);
    avatar.dataset.hat      = data.get('hat');
    avatar.dataset.cloak    = data.get('cloak');
    avatar.dataset.weapon   = data.get('weapon');
    avatar.dataset.eyes     = data.get('eyes');
    avatar.dataset.strength = data.get('strength');
  };
  form.addEventListener('input', updatePreview);
  // initial defaults
  form.hat.value='wizard'; form.cloak.value='rose'; form.weapon.value='wand';
  form.eyes.value='sparkle'; form.strength.value='fire'; form.weakness.value='water';
  updatePreview();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(form).entries());
    if (!raw.name?.trim()) { form.name.focus(); return; }
    Game.party.push(new Character(raw));
    Game.creatorIndex++;
    if (Game.creatorIndex >= Game.playerCount){
      setPhase('theme');
    } else {
      // re-render for next hero
      setPhase('creator');
    }
  });
  mount(node);
}

// -------- 4c. Theme --------
function renderTheme(){
  const node = clone('tpl-theme');
  const grid = node.querySelector('#theme-grid');
  THEMES.forEach((t) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.theme = t.id;
    card.dataset.testid = `theme-${t.id}`;
    card.innerHTML = `<span class="icon">${t.icon}</span><h4>${t.title}</h4><p>${t.blurb}</p>`;
    card.addEventListener('click', () => {
      grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      Game.theme = t;
      node.querySelector('#start-game-btn').disabled = false;
    });
    grid.appendChild(card);
  });

  // party preview
  const preview = node.querySelector('#party-preview');
  Game.party.forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'party-chip';
    chip.append(buildMiniAvatar(c, 46));
    const nm = document.createElement('span'); nm.className='name'; nm.textContent = c.name;
    const rl = document.createElement('span'); rl.className='role-tag'; rl.textContent = c.role;
    chip.append(nm, rl);
    preview.appendChild(chip);
  });

  node.querySelector('#start-game-btn').addEventListener('click', () => {
    if (!Game.theme) return;
    Game.turnIndex = 0;
    Game.log = [{ kind:'note', text:`${Game.dmName} opens the book and clears their throat. The chapter is "${Game.theme.title}".` }];
    setPhase('play');
  });
  mount(node);
}

// -------- 4d. Play stage --------
function renderGame(){
  const node = clone('tpl-game');
  mount(node);
  refreshGame();
}

function refreshGame(){
  // party rail
  const rail = document.getElementById('party-rail');
  rail.innerHTML = '';
  Game.party.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'party-card' + (idx === Game.turnIndex && c.isAlive ? ' active' : '') + (c.isAlive ? '' : ' fallen');
    card.dataset.testid = `party-card-${idx}`;
    const av = buildMiniAvatar(c, 58);
    card.append(av);
    const body = document.createElement('div');
    body.className = 'pc-body';
    body.innerHTML = `
      <h4 class="pc-name">${c.name}</h4>
      <div class="pc-meta">${c.kind} · ${c.strength} · <span class="role-${c.role.slice(0,4)}">${c.role}</span></div>
      <div class="pc-hp"><div class="pc-hp-fill" style="width:${(c.hp/c.maxHp)*100}%"></div></div>`;
    card.append(body);
    rail.append(card);
  });

  // theme banner
  document.getElementById('theme-banner').innerHTML = `
    <div>
      <div class="t-title">${Game.theme.icon} ${Game.theme.title}</div>
      <div class="t-blurb">${Game.theme.blurb}</div>
    </div>
    <div class="t-blurb">— narrated by ${Game.dmName}</div>`;

  // narration uses innerHTML — text we push is already user-escaped above
  const lastNote = [...Game.log].reverse().find(l => l.kind === 'note');
  document.getElementById('narration').innerHTML = lastNote ? lastNote.text : '…';

  // current player
  const alive = Game.party.filter(c => c.isAlive);
  if (alive.length <= 1){
    endGame();
    return;
  }
  // advance turn if current is dead
  while (!Game.party[Game.turnIndex].isAlive) Game.turnIndex = (Game.turnIndex + 1) % Game.party.length;

  const current = Game.party[Game.turnIndex];
  document.getElementById('turn-name').textContent = `${current.name} — the ${current.kind}`;
  const targetSel = document.getElementById('target-select');
  targetSel.innerHTML = '';
  Game.party.forEach((c, i) => {
    if (i === Game.turnIndex || !c.isAlive) return;
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = `${c.name} (${c.hp}/${c.maxHp})`;
    targetSel.append(opt);
  });

  // event handlers (idempotent: clone-replace removes old listeners)
  const attackBtn = document.getElementById('attack-btn');
  const skipBtn   = document.getElementById('skip-btn');
  const newAtk = attackBtn.cloneNode(true); attackBtn.replaceWith(newAtk);
  const newSkip = skipBtn.cloneNode(true);  skipBtn.replaceWith(newSkip);

  newAtk.addEventListener('click', () => startRiddleEncounter(current, targetSel.value));
  newSkip.addEventListener('click', () => {
    const txt = document.getElementById('action-text').value.trim();
    Game.log.push({ kind:'note', text:`${current.name} ${txt || 'breathes, watches, and waits.'} (pass)` });
    nextTurn();
  });

  // log
  const logEl = document.getElementById('log');
  logEl.innerHTML = '';
  Game.log.slice(-12).forEach(l => {
    const div = document.createElement('div');
    div.className = 'entry ' + (l.kind || '');
    div.innerHTML = l.text;
    logEl.append(div);
  });
  logEl.scrollTop = logEl.scrollHeight;

  Game.save();
}

function nextTurn(){
  Game.turnIndex = (Game.turnIndex + 1) % Game.party.length;
  document.getElementById('action-text') && (document.getElementById('action-text').value = '');
  refreshGame();
}

// -------- 4e. Riddle encounter --------
async function startRiddleEncounter(attacker, targetId){
  const target = Game.party.find(c => c.id === targetId);
  if (!target || !target.isAlive) return;

  const actionTxt = (document.getElementById('action-text').value || '').trim();
  const escape = (s) => s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  if (actionTxt) Game.log.push({ kind:'note', text:`<b>${escape(attacker.name)}:</b> "${escape(actionTxt)}"` });

  // build modal
  const modal = clone('tpl-riddle');
  document.body.append(modal);
  modal.querySelector('[data-slot="attacker"]').textContent = attacker.name;
  modal.querySelector('[data-slot="target"]').textContent   = target.name;

  const riddleText = modal.querySelector('#riddle-text');
  const sourceTag  = modal.querySelector('#riddle-source-tag');
  const inputEl    = modal.querySelector('#riddle-answer');
  const resultEl   = modal.querySelector('#riddle-result');
  const rollBtn    = modal.querySelector('#roll-btn');
  const revealBtn  = modal.querySelector('#reveal-btn');
  const rerollBtn  = modal.querySelector('#reroll-riddle');
  const customBtn  = modal.querySelector('#custom-riddle');
  const dieA = modal.querySelector('#die-d20');
  const dieB = modal.querySelector('#die-d6');

  let riddle = null;
  const loadRiddle = async () => {
    riddleText.textContent = '… fetching a riddle from the wind …';
    sourceTag.textContent = '…';
    riddle = await fetchRiddle();
    riddleText.textContent = riddle.q;
    sourceTag.textContent = riddle.source === 'api' ? 'API riddle' : 'tome riddle';
  };
  await loadRiddle();

  rerollBtn.addEventListener('click', loadRiddle);
  customBtn.addEventListener('click', () => {
    const q = prompt('Write your custom riddle:');
    if (!q) return;
    const a = prompt('And its single-word answer:');
    if (!a) return;
    riddle = { q, a: a.trim().toLowerCase(), source:'custom' };
    riddleText.textContent = q;
    sourceTag.textContent = 'custom riddle';
  });

  const close = () => modal.remove();

  const resolve = (solved) => {
    // dice roll with animation
    dieA.classList.add('rolling'); dieB.classList.add('rolling');
    setTimeout(() => {
      const d20 = rollDie(20);
      const d6  = rollDie(6);
      dieA.querySelector('span').textContent = d20;
      dieB.querySelector('span').textContent = d6;
      dieA.classList.remove('rolling'); dieB.classList.remove('rolling');

      const bonus = attacker.attackBonusVs(target);
      const riddleBonus = solved ? 6 : -2;
      const attackScore = d20 + riddleBonus + Math.floor(bonus/2);
      const hit = attackScore >= 12;
      let damage = 0;
      if (hit){
        damage = d6 + (solved ? bonus : Math.floor(bonus/2));
        target.takeDamage(damage);
      }

      const verb = ['conjures','hurls','flicks','weaves','launches'][Math.floor(Math.random()*5)];
      const elementWord = { fire:'a curl of flame', ice:'a shard of frost', light:'a beam of dawn', shadow:'a tendril of dusk', nature:'a swirl of leaves' }[attacker.strength];
      let line = `<b>${attacker.name}</b> ${verb} ${elementWord} at <b>${target.name}</b>. `;
      line += solved ? `Riddle solved — d20 <b>${d20}</b> + d6 <b>${d6}</b>. ` : `Riddle missed — d20 <b>${d20}</b> + d6 <b>${d6}</b>. `;
      if (hit && target.isAlive){
        line += `It lands. <b>−${damage}</b> vitality.`;
        Game.log.push({ kind:'hit', text:line });
        resultEl.className = 'riddle-result hit';
        resultEl.textContent = `A clean strike! ${target.name} loses ${damage} vitality.`;
      } else if (hit && !target.isAlive){
        line += `<b>${target.name} falls!</b>`;
        Game.log.push({ kind:'kill', text:line });
        resultEl.className = 'riddle-result hit';
        resultEl.textContent = `${target.name} crumples to the floor…`;
        // dramatic death animation on the rail mini-avatar
        const idx = Game.party.findIndex(c => c.id === target.id);
        const railCards = document.querySelectorAll('#party-rail .party-card .mini-avatar');
        if (railCards[idx]) railCards[idx].classList.add('dying');
      } else {
        line += `The blow goes wide.`;
        Game.log.push({ kind:'miss', text:line });
        resultEl.className = 'riddle-result miss';
        resultEl.textContent = 'A miss! The shot scatters into mist.';
      }

      setTimeout(() => {
        close();
        nextTurn();
      }, 1600);
    }, 850);
  };

  rollBtn.addEventListener('click', () => {
    const ok = answerMatches(riddle.a, inputEl.value);
    resolve(ok);
  });
  revealBtn.addEventListener('click', () => {
    resultEl.className = 'riddle-result miss';
    resultEl.textContent = `Answer was “${riddle.a}”. Giving up costs you a clean hit.`;
    setTimeout(() => resolve(false), 700);
  });
  inputEl.focus();
}

// ===================================================================
// 5. END / CREDITS — survivors dance
// ===================================================================

function endGame(){
  setPhase('credits');
  const node = clone('tpl-credits');
  mount(node);

  const survivors = Game.party.filter(c => c.isAlive);
  const fallen    = Game.party.filter(c => !c.isAlive);

  const summary =
    survivors.length === 0 ? 'No one remained when the candle guttered out.' :
    survivors.length === 1 ? `${survivors[0].name} alone walks back into the dawn.` :
    survivors.length === 2 ? `${survivors[0].name} and ${survivors[1].name} stride home, side by side.` :
    `${survivors.length} brave souls share the last sip of cider.`;
  document.getElementById('credits-summary').textContent = summary;

  // dance floor
  const floor = document.getElementById('dance-floor');
  floor.innerHTML = '';
  const danceClass =
    survivors.length === 1 ? ['solo'] :
    survivors.length === 2 ? ['duo-a','duo-b'] :
    survivors.map(() => 'group');

  survivors.forEach((c, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'dancer ' + (danceClass[idx] || 'group');
    wrap.style.animationDelay = (idx * 0.15) + 's';
    wrap.innerHTML = `
      <div class="avatar" data-hat="${c.hat}" data-cloak="${c.cloak}" data-weapon="${c.weapon}" data-eyes="${c.eyes}" data-strength="${c.strength}">
        <div class="hat"></div>
        <div class="cloak"></div>
        <div class="head">
          <div class="eye left"></div>
          <div class="eye right"></div>
          <div class="cheek left"></div>
          <div class="cheek right"></div>
          <div class="mouth"></div>
        </div>
        <div class="hand left"><div class="element-fx"></div></div>
        <div class="hand right"><div class="weapon"></div></div>
        <div class="shadow"></div>
      </div>`;
    floor.append(wrap);
  });

  if (survivors.length === 0){
    const note = document.createElement('div');
    note.style.fontFamily = 'Caveat, cursive';
    note.style.fontSize = '32px';
    note.style.color = 'var(--plum)';
    note.textContent = 'a silence, then the curtain falls.';
    floor.append(note);
  }

  // credits list
  const list = document.getElementById('credits-list');
  list.innerHTML = '';
  list.append(buildCredit('Dungeon Master', Game.dmName));
  Game.party.forEach(c => list.append(buildCredit(c.role, c.name, !c.isAlive)));

  document.getElementById('play-again').addEventListener('click', () => {
    Game.reset();
    setPhase('welcome');
  });
}

function buildCredit(role, who, fallen = false){
  const row = document.createElement('div');
  row.className = 'credit-row' + (fallen ? ' fallen' : '');
  row.innerHTML = `<span class="role">${role}</span><span class="who">${who}</span>`;
  return row;
}

// ===================================================================
// 6. ROUTER — wire phases to renderers
// ===================================================================

const renderers = {
  welcome: renderWelcome,
  creator: renderCreator,
  theme:   renderTheme,
  play:    renderGame,
  credits: () => {/* drawn in endGame */},
};

bus.on('phase', (p) => {
  const fn = renderers[p];
  if (fn) fn();
});

// kick off
setPhase('welcome');

})();
