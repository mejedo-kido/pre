/* game.js — enemy skills visible UI + enemy hands fixed (no stage scaling)
   - 敵の手はステージで増えない（rand(1,2) 固定）
   - 敵スキルを付与し、戦闘中に使用。スキルは画面上に表示される。
*/

const MAX_VALUE = 4;
const STORAGE_KEY = 'fd_unlocked_skills_v2'; // skill storage
const BEST_KEY = 'fd_best_stage_v1';
const EQUIP_SLOTS = 3;
const MAX_SKILL_LEVEL = 3;

/* ---------- SKILL POOL ---------- */
const SKILL_POOL = [
  { id:'power', type:'passive', baseDesc:'攻撃 +1 / level', name:'💥 パワーアップ' },
  { id:'guard', type:'passive', baseDesc:'敵攻撃 -1 / level', name:'🛡 ガード' },
  { id:'berserk', type:'passive', baseDesc:'自分の手が4のとき攻撃 +level', name:'⚡ バーサーク' },
  { id:'regen', type:'turn', baseDesc:'敵ターン後にランダムな手 +1 ×level', name:'💚 リジェネ' },
  { id:'double', type:'active', baseDesc:'次の攻撃が (1 + level) 倍', name:'⛏ ダブルストライク' },
  { id:'heal', type:'active', baseDesc:'味方の手を + (1 + level)', name:'✨ ヒール' },
  { id:'pierce', type:'passive', baseDesc:'破壊閾値を -level（最小2）', name:'🔩 ピアス' },
  { id:'chain', type:'combo', baseDesc:'敵手を破壊した次の攻撃 +level', name:'🔗 チェイン' },
  { id:'fortify', type:'turn', baseDesc:'自分の防御+1 for 2 turns ×level', name:'🏰 フォーティファイ' },
  { id:'revenge', type:'event', baseDesc:'自分の手が0になったら即ヒール +level', name:'🔥 リベンジ' }
];

/* ---------- game state (added enemy skill storage & buffs) ---------- */
const gameState = {
  stage: 1,
  isBoss: false,
  player: { left: 1, right: 1 },
  enemy: { left: 1, right: 1 },
  playerTurn: true,
  unlockedSkills: [],
  equippedSkills: [],
  pendingActiveUse: null,
  doubleMultiplier: 1,
  turnBuffs: [],
  bestStage: 1,
  inTitle: true,
  enemySkills: [],            // 敵が持つスキル
  enemyDoubleMultiplier: 1,   // 敵の次攻撃倍率
  enemyTurnBuffs: []          // 敵のターンバフ（fortify 等）
};

let selectedHand = null;
let equipTemp = [];

/* ---------- DOM ---------- */
const titleScreen = document.getElementById('titleScreen');
const startButton = document.getElementById('startButton');
const resetButton = document.getElementById('resetButton');
const bestStageValue = document.getElementById('bestStageValue');

const stageInfo = document.getElementById('stageInfo');
const skillInfo = document.getElementById('skillInfo') || (() => { const el=document.createElement('div'); el.id='skillInfo'; document.querySelector('.container').prepend(el); return el; })();
const messageArea = document.getElementById('message');
const skillSelectArea = document.getElementById('skillSelectArea');
const equippedList = document.getElementById('equippedList');
const unlockedList = document.getElementById('unlockedList');
const flashLayer = document.getElementById('flashLayer');

const enemySkillArea = document.getElementById('enemySkillArea'); // ← 敵スキル表示領域

const hands = {
  playerLeft: document.getElementById('player-left'),
  playerRight: document.getElementById('player-right'),
  enemyLeft: document.getElementById('enemy-left'),
  enemyRight: document.getElementById('enemy-right')
};

const bars = {
  playerLeft: document.getElementById('player-left-bar'),
  playerRight: document.getElementById('player-right-bar'),
  enemyLeft: document.getElementById('enemy-left-bar'),
  enemyRight: document.getElementById('enemy-right-bar')
};

/* ---------- SE (optional) ---------- */
const SE = {
  click: typeof Audio !== 'undefined' ? new Audio('assets/sounds/click.mp3') : null,
  attack: typeof Audio !== 'undefined' ? new Audio('assets/sounds/attack.mp3') : null,
  destroy: typeof Audio !== 'undefined' ? new Audio('assets/sounds/destroy.mp3') : null,
  skill: typeof Audio !== 'undefined' ? new Audio('assets/sounds/skill.mp3') : null,
  victory: typeof Audio !== 'undefined' ? new Audio('assets/sounds/victory.mp3') : null,
  lose: typeof Audio !== 'undefined' ? new Audio('assets/sounds/lose.mp3') : null
};
function playSE(name, volume = 0.6){
  const s = SE[name];
  if(!s) return;
  try {
    const snd = s.cloneNode();
    snd.volume = volume;
    const p = snd.play();
    if(p && typeof p.catch === 'function') p.catch(()=>{});
  } catch(e){}
}

/* ---------- utils & persistence ---------- */
const rand = (min,max) => Math.floor(Math.random()*(max-min+1))+min;
function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

function saveUnlocked(){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState.unlockedSkills)); } catch(e){} }
function loadUnlocked(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed)){
      if(parsed.length === 0) return [];
      if(typeof parsed[0] === 'string') return parsed.map(id=>({ id, level:1 }));
      if(typeof parsed[0] === 'object' && parsed[0].id) return parsed.map(o=>({ id:o.id, level:o.level||1 }));
    }
  } catch(e){}
  return null;
}

function loadBest(){ try { const b = Number(localStorage.getItem(BEST_KEY)); return Number.isFinite(b) && b > 0 ? b : 1; } catch(e){ return 1; } }
function saveBest(){ try { localStorage.setItem(BEST_KEY, String(gameState.bestStage)); } catch(e){} }

/* ---------- seeding & reset ---------- */
function seedInitialUnlocks(){
  gameState.unlockedSkills = [{ id:'power', level:1 }, { id:'guard', level:1 }];
  saveUnlocked();
}

/* Reset: clear stored unlocked skills and re-seed initial skills */
function resetGame(){
  if(!confirm('スキルのアンロックを初期状態にリセットします。\nよろしいですか？')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch(e){}
  seedInitialUnlocks();

  gameState.stage = 1;
  gameState.isBoss = false;
  gameState.player = { left:1, right:1 };
  gameState.enemy = { left:1, right:1 };
  gameState.playerTurn = true;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.turnBuffs = [];
  gameState.equippedSkills = [];
  gameState.enemySkills = [];
  gameState.enemyDoubleMultiplier = 1;
  gameState.enemyTurnBuffs = [];
  selectedHand = null;
  equipTemp = [];

  renderUnlockedList();
  if(equippedList) equippedList.innerHTML = '';
  messageArea.textContent = 'スキルをリセットしました（初期スキルに戻しました）';
  showTitle();
}

/* ---------- init & title handling ---------- */
function initGame(){
  const loaded = loadUnlocked();
  if(loaded && loaded.length>0) gameState.unlockedSkills = loaded;
  else seedInitialUnlocks();

  gameState.bestStage = loadBest();
  bestStageValue.textContent = gameState.bestStage;

  showTitle();

  startButton.onclick = () => { playSE('click', 0.5); startGame(); };
  resetButton.onclick = () => { playSE('click', 0.5); resetGame(); };
}

function showTitle(){
  gameState.inTitle = true;
  if(titleScreen) titleScreen.style.display = 'flex';
  bestStageValue.textContent = gameState.bestStage;
}
function hideTitle(){
  gameState.inTitle = false;
  if(titleScreen) titleScreen.style.display = 'none';
}

/* ---------- start / stage flow ---------- */
function startGame(){
  gameState.stage = 1;
  gameState.playerTurn = true;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.turnBuffs = [];
  selectedHand = null;
  equipTemp = [];
  hideTitle();
  messageArea.textContent = '';
  startBattle();
}

function startBattle(){
  equipTemp = [];
  selectedHand = null;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.equippedSkills = [];
  gameState.turnBuffs = [];
  gameState.playerTurn = true;

  // player always full at stage start
  gameState.player.left = 1;
  gameState.player.right = 1;

  gameState.isBoss = (gameState.stage % 3 === 0);
  document.body.classList.toggle('boss', gameState.isBoss);

  // === IMPORTANT CHANGE ===
  // Enemy hands: no stage-based increase. Keep small fixed values (variety: 1 or 2).
  gameState.enemy.left = rand(1, 2);
  gameState.enemy.right = rand(1, 2);

  // reset enemy buffs & multiplier, then assign skills
  gameState.enemyDoubleMultiplier = 1;
  gameState.enemyTurnBuffs = [];
  assignEnemySkills();

  updateUI();
  showEquipSelection();
  renderUnlockedList();
}

/* ---------- assign enemy skills ---------- */
function assignEnemySkills(){
  // pick a few skills from SKILL_POOL for the enemy (avoid revenge by default)
  const possible = SKILL_POOL.slice().filter(s => s.id !== 'revenge');
  // scale skill count modestly with stage (but not hands)
  const skillCount = Math.min(3, 1 + Math.floor(gameState.stage / 4));
  const chosen = [];
  let pool = possible.slice();
  while(chosen.length < skillCount && pool.length > 0){
    const idx = rand(0, pool.length - 1);
    const s = pool.splice(idx, 1)[0];
    // level scales gently with stage
    const level = Math.min(MAX_SKILL_LEVEL, 1 + Math.floor(gameState.stage / 6));
    chosen.push({ id: s.id, level, type: s.type, name: s.name, remainingCooldown: 0 });
  }
  gameState.enemySkills = chosen;
  updateEnemySkillUI();
}

/* ---------- equip selection UI (unchanged) ---------- */
function showEquipSelection(){
  skillSelectArea.innerHTML = '';
  messageArea.textContent = `装備スキルを最大${EQUIP_SLOTS}つ選んで「確定」してください`;

  const wrap = document.createElement('div');
  wrap.className = 'skill-choices';

  gameState.unlockedSkills.forEach(us => {
    const def = SKILL_POOL.find(s=>s.id===us.id);
    if(!def) return;
    const btn = document.createElement('button');
    btn.className = 'skill-btn';
    btn.dataset.id = us.id;
    btn.innerHTML = `<div style="font-weight:700">${def.name} Lv${us.level}</div><small style="opacity:.9">${def.baseDesc}</small>`;
    btn.onclick = () => {
      playSE('click', 0.5);
      const idx = equipTemp.indexOf(us.id);
      if(idx === -1){
        if(equipTemp.length >= EQUIP_SLOTS){
          messageArea.textContent = `最大${EQUIP_SLOTS}つまで装備できます`;
          setTimeout(()=> messageArea.textContent = `装備スキルを最大${EQUIP_SLOTS}つ選んで「確定」してください`, 900);
          return;
        }
        equipTemp.push(us.id);
        btn.classList.add('chosen');
      } else {
        equipTemp.splice(idx,1);
        btn.classList.remove('chosen');
      }
    };
    wrap.appendChild(btn);
  });

  const confirm = document.createElement('button');
  confirm.textContent = '確定';
  confirm.style.marginLeft = '8px';
  confirm.onclick = () => { playSE('click', 0.5); commitEquips(); };

  skillSelectArea.appendChild(wrap);
  skillSelectArea.appendChild(confirm);
}

function commitEquips(){
  gameState.equippedSkills = equipTemp.map(id => {
    const unlocked = gameState.unlockedSkills.find(u=>u.id===id);
    const def = SKILL_POOL.find(s=>s.id===id);
    return {
      id: def.id,
      level: (unlocked && unlocked.level) ? unlocked.level : 1,
      type: def.type,
      name: def.name,
      desc: def.baseDesc,
      used: false,
      remainingTurns: 0
    };
  });
  equipTemp = [];
  skillSelectArea.innerHTML = '';
  messageArea.textContent = '';
  renderEquipped();
  renderUnlockedList();
  skillInfo.textContent = 'Equipped: ' + (gameState.equippedSkills.map(s=>`${s.name} Lv${s.level}`).join(', ') || '—');
}

/* ---------- rendering (unchanged) ---------- */
function renderEquipped(){
  equippedList.innerHTML = '';
  if(!gameState.equippedSkills || gameState.equippedSkills.length === 0){
    equippedList.textContent = '(None)';
    return;
  }
  gameState.equippedSkills.forEach((s, idx) => {
    const card = document.createElement('div');
    card.className = 'skill-card';
    if(s.type === 'passive' || s.type === 'combo' || s.type === 'event' ){
      card.innerHTML = `<div class="skill-passive">${s.name} Lv${s.level}<div style="font-size:12px;opacity:.85">${s.desc}</div></div>`;
    } else if(s.type === 'active' || s.type === 'turn'){
      const btn = document.createElement('button');
      btn.textContent = `${s.name} Lv${s.level}`;
      btn.disabled = s.used;
      if(s.used) btn.classList.add('used');
      btn.onclick = () => {
        if(s.used) return;
        playSE('skill', 0.7);
        if(s.id === 'double'){
          s.used = true;
          gameState.doubleMultiplier = 1 + s.level;
          messageArea.textContent = `${s.name} を発動（次の攻撃が×${gameState.doubleMultiplier}）`;
          renderEquipped();
        } else if(s.id === 'heal'){
          gameState.pendingActiveUse = { id: 'heal', idx };
          messageArea.textContent = 'ヒール使用：回復する味方の手を選んでください';
        } else if(s.type === 'turn'){
          s.used = true;
          const duration = 2 * s.level;
          s.remainingTurns = duration;
          applyTurnBuff(s.id, s.level, duration);
          messageArea.textContent = `${s.name} を ${duration} ターン有効化しました`;
          renderEquipped();
        }
      };
      const div = document.createElement('div');
      div.className = 'skill-active';
      div.appendChild(btn);
      card.appendChild(div);
    }
    equippedList.appendChild(card);
  });
}

function renderUnlockedList(){
  unlockedList.innerHTML = '';
  if(!gameState.unlockedSkills || gameState.unlockedSkills.length === 0){
    unlockedList.textContent = '(No unlocked skills)';
    return;
  }
  gameState.unlockedSkills.forEach(u => {
    const def = SKILL_POOL.find(s=>s.id===u.id);
    if(!def) return;
    const card = document.createElement('div');
    card.className = 'skill-card';
    card.innerHTML = `<div style="font-weight:700">${def.name} Lv${u.level}</div><div style="font-size:12px;opacity:.85">${def.baseDesc}</div>`;
    unlockedList.appendChild(card);
  });
}

/* ---------- enemy skill UI ---------- */
function updateEnemySkillUI(){
  if(!enemySkillArea) return;
  if(!gameState.enemySkills || gameState.enemySkills.length === 0){
    enemySkillArea.textContent = '敵スキル: —';
    return;
  }

  const skillTexts = gameState.enemySkills.map(s => {
    let txt = `${s.name} Lv${s.level}`;
    if(s.remainingCooldown && s.remainingCooldown > 0){
      txt += ` (CD:${s.remainingCooldown})`;
    }
    return txt;
  });

  const buffs = gameState.enemyTurnBuffs.map(tb => {
    if(tb.skillId === 'fortify') return `防御+${tb.payload.value} (${tb.remainingTurns})`;
    if(tb.skillId === 'chain') return `次攻撃+${tb.payload.value} (${tb.remainingTurns})`;
    return '';
  }).filter(v => v !== '');

  const buffText = buffs.length ? ` | Buffs: ${buffs.join(', ')}` : '';
  enemySkillArea.textContent = `敵スキル: ${skillTexts.join(', ')}${buffText}`;
}

/* ---------- UI update ---------- */
function updateUI(){
  stageInfo.textContent = `Stage ${gameState.stage} ${gameState.isBoss ? 'BOSS' : ''}`;
  skillInfo.textContent = gameState.equippedSkills && gameState.equippedSkills.length ? 'Equipped: ' + gameState.equippedSkills.map(s=>`${s.name} Lv${s.level}`).join(', ') : 'Equipped: —';
  updateHand('playerLeft', gameState.player.left);
  updateHand('playerRight', gameState.player.right);
  updateHand('enemyLeft', gameState.enemy.left);
  updateHand('enemyRight', gameState.enemy.right);
  updateEnemySkillUI(); // ← 敵スキル UI 更新
}

function updateHand(key, value){
  const el = hands[key];
  const bar = bars[key];
  const v = toNum(value);
  if(el) { el.textContent = v; el.classList.toggle('zero', v === 0); }
  if(bar) bar.style.width = (v / MAX_VALUE) * 100 + '%';
}

/* ---------- FX helpers ---------- */
function flashScreen(duration = 0.18){
  if(!flashLayer) return;
  flashLayer.classList.add('flash');
  setTimeout(()=> flashLayer.classList.remove('flash'), Math.max(80, duration*1000));
}
function showDamage(targetEl, val, color='#ff6b6b'){
  if(!targetEl) return;
  const d = document.createElement('div');
  d.className = 'damage';
  d.textContent = `+${val}`;
  d.style.color = color;
  targetEl.appendChild(d);
  setTimeout(()=> d.remove(), 820);
}
function animateAttack(attackerEl, targetEl){
  if(attackerEl) attackerEl.classList.add('attack');
  if(targetEl) targetEl.classList.add('hit');
  setTimeout(()=>{ if(attackerEl) attackerEl.classList.remove('attack'); if(targetEl) targetEl.classList.remove('hit'); }, 320);
}
function animateDestroy(targetEl){
  if(!targetEl) return;
  targetEl.classList.add('destroy');
  setTimeout(()=> targetEl.classList.remove('destroy'), 500);
}

/* ---------- skill engine helpers ---------- */
function getUnlockedLevel(id){
  const u = (gameState.unlockedSkills || []).find(x=>x.id===id);
  return u ? (u.level || 1) : 0;
}
function hasEquipped(id){
  return (gameState.equippedSkills || []).some(s=>s.id===id);
}
function getEquippedLevel(id){
  const s = (gameState.equippedSkills || []).find(x=>x.id===id);
  return s ? s.level : 0;
}
function applyTurnBuff(skillId, level, duration){
  let payload = {};
  if(skillId === 'fortify') payload = { type:'guardBoost', value: level };
  else payload = { type: skillId, value: level };
  gameState.turnBuffs.push({ skillId, remainingTurns: duration, payload });
}
function tickTurnBuffs(){
  gameState.turnBuffs.forEach(tb => tb.remainingTurns = Math.max(0, tb.remainingTurns - 1));
  gameState.turnBuffs = gameState.turnBuffs.filter(tb => tb.remainingTurns > 0);
  (gameState.equippedSkills || []).forEach(s => { if(s.remainingTurns > 0) s.remainingTurns = Math.max(0, s.remainingTurns - 1); });
}

/* ---------- enemy turn-buff helpers ---------- */
function applyEnemyTurnBuff(skillId, level, duration){
  let payload = {};
  if(skillId === 'fortify') payload = { type:'enemyGuardBoost', value: level };
  else payload = { type: skillId, value: level };
  gameState.enemyTurnBuffs.push({ skillId, remainingTurns: duration, payload });
}
function tickEnemyTurnBuffs(){
  gameState.enemyTurnBuffs.forEach(tb => tb.remainingTurns = Math.max(0, tb.remainingTurns - 1));
  gameState.enemyTurnBuffs = gameState.enemyTurnBuffs.filter(tb => tb.remainingTurns > 0);
  (gameState.enemySkills || []).forEach(s => { if(s.remainingCooldown && s.remainingCooldown > 0) s.remainingCooldown = Math.max(0, s.remainingCooldown - 1); });
}

/* ---------- compute bonuses ---------- */
function computePlayerAttackBonus(handKey){
  let bonus = 0;
  (gameState.equippedSkills || []).forEach(s => {
    if(s.type !== 'passive') return;
    if(s.id === 'power') bonus += s.level;
    if(s.id === 'berserk' && toNum(gameState.player[handKey]) === 4) bonus += s.level;
  });
  gameState.turnBuffs.forEach(tb => {
    if(tb.payload && tb.payload.type === 'chainBoost') bonus += tb.payload.value;
  });
  return bonus;
}
function computeEnemyAttackReduction(){
  // reduction from player's guard and fortify-type buffs
  let reduction = 0;
  (gameState.equippedSkills || []).forEach(s => {
    if(s.type === 'passive' && s.id === 'guard') reduction += s.level;
  });
  gameState.turnBuffs.forEach(tb => { if(tb.payload && tb.payload.type === 'guardBoost') reduction += tb.payload.value; });
  return reduction;
}
function computeEnemyAttackBonus(attackerHandKey){
  // enemy passive bonuses (power / berserk) from enemySkills
  let bonus = 0;
  (gameState.enemySkills || []).forEach(s => {
    if(s.type !== 'passive') return;
    if(s.id === 'power') bonus += s.level;
    if(s.id === 'berserk' && toNum(gameState.enemy[attackerHandKey]) === 4) bonus += s.level;
  });
  gameState.enemyTurnBuffs.forEach(tb => {
    if(tb.payload && tb.payload.type === 'chainBoost') bonus += tb.payload.value;
  });
  return bonus;
}

/* ---------- destroy threshold (attacker-aware) ---------- */
function getDestroyThreshold(attackerIsPlayer = true){
  // base threshold 5, lowered by pierce on attacker side (min 2)
  let threshold = 5;
  if(attackerIsPlayer){
    (gameState.equippedSkills || []).forEach(s => {
      if(s.type === 'passive' && s.id === 'pierce') threshold = Math.max(2, threshold - s.level);
    });
  } else {
    (gameState.enemySkills || []).forEach(s => {
      if(s.type === 'passive' && s.id === 'pierce') threshold = Math.max(2, threshold - s.level);
    });
  }
  return threshold;
}

/* ---------- active handlers ---------- */
function applyPendingActiveOnPlayer(side){
  if(!gameState.pendingActiveUse) return;
  const pending = gameState.pendingActiveUse;
  const sk = gameState.equippedSkills[pending.idx];
  if(!sk || sk.used){ gameState.pendingActiveUse = null; messageArea.textContent = 'そのスキルは使用できません'; return; }

  if(pending.id === 'heal'){
    const amount = 1 + sk.level;
    playSE('skill', 0.7);
    const cur = toNum(gameState.player[side]);
    gameState.player[side] = Math.min(MAX_VALUE, cur + amount);
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (+${amount})`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showDamage(el, amount, '#7be38a');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
  }
}

/* ---------- player attack ---------- */
function playerAttack(targetSide){
  if(skillSelectArea && skillSelectArea.children.length > 0){
    messageArea.textContent = 'まず装備を確定してください'; return;
  }
  if(!gameState.playerTurn) return;
  if(!selectedHand){ messageArea.textContent = '攻撃する手を選んでください'; return; }
  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'heal'){ messageArea.textContent = 'ヒール使用中：味方の手を選んでください'; return; }

  const attackerKey = selectedHand;
  const attackerEl = hands[attackerKey === 'left' ? 'playerLeft' : 'playerRight'];
  const targetEl = hands[targetSide === 'left' ? 'enemyLeft' : 'enemyRight'];

  playSE('attack', 0.7);
  animateAttack(attackerEl, targetEl);

  let baseAtk = toNum(gameState.player[attackerKey]);
  baseAtk += computePlayerAttackBonus(attackerKey);

  let multiplier = gameState.doubleMultiplier || 1;
  gameState.doubleMultiplier = 1;
  if(multiplier > 1){
    const idx = (gameState.equippedSkills || []).findIndex(s => s.id === 'double' && !s.used);
    if(idx !== -1) { gameState.equippedSkills[idx].used = true; renderEquipped(); }
  }

  showDamage(targetEl, baseAtk);

  const curEnemy = toNum(gameState.enemy[targetSide]);
  const added = baseAtk * multiplier;
  let newVal = curEnemy + added;
  if(!Number.isFinite(newVal)) newVal = 0;

  const destroyThreshold = getDestroyThreshold(true); // player is attacker
  let destroyed = false;
  if(newVal >= destroyThreshold){
    newVal = 0;
    destroyed = true;
    animateDestroy(targetEl);
    playSE('destroy', 0.9);
  } else {
    if(newVal > MAX_VALUE) newVal = MAX_VALUE;
  }

  gameState.enemy[targetSide] = newVal;

  if(destroyed && hasEquipped('chain')){
    const lvl = getEquippedLevel('chain');
    applyTurnBuff('chainBoost', lvl, 1);
    const tb = gameState.turnBuffs[gameState.turnBuffs.length - 1];
    if(tb) tb.payload = { type:'chainBoost', value: lvl };
    messageArea.textContent = `チェイン発動！次の攻撃が +${lvl}されます`;
  }

  clearHandSelection();
  gameState.playerTurn = false;
  updateUI();
  flashScreen();

  if(!checkWinLose()) setTimeout(()=> enemyTurn(), 650);
}

/* ---------- enemy turn (updated) ---------- */
function enemyTurn(){
  const alivePlayer = ['left','right'].filter(s => toNum(gameState.player[s]) > 0);
  const aliveEnemy = ['left','right'].filter(s => toNum(gameState.enemy[s]) > 0);

  if(alivePlayer.length === 0 || aliveEnemy.length === 0) return;

  // --- enemy pre-action: consider using skills (simple AI with cooldowns & probabilities) ---
  (gameState.enemySkills || []).forEach(skill => {
    if(skill.remainingCooldown && skill.remainingCooldown > 0) return;

    if(skill.id === 'heal'){
      const damaged = ['left','right'].filter(k => toNum(gameState.enemy[k]) > 0 && toNum(gameState.enemy[k]) < MAX_VALUE);
      if(damaged.length > 0 && Math.random() < 0.6){
        const r = damaged[rand(0, damaged.length - 1)];
        const amount = 1 + skill.level;
        gameState.enemy[r] = Math.min(MAX_VALUE, toNum(gameState.enemy[r]) + amount);
        const el = hands[r === 'left' ? 'enemyLeft' : 'enemyRight'];
        showDamage(el, amount, '#ff9e9e');
        playSE('skill', 0.6);
        skill.remainingCooldown = 2;
      }
    }

    if(skill.id === 'double'){
      if(Math.random() < 0.35){
        gameState.enemyDoubleMultiplier = 1 + skill.level;
        messageArea.textContent = `敵が ${skill.name} を発動した！次の攻撃が×${gameState.enemyDoubleMultiplier}`;
        playSE('skill', 0.6);
        skill.remainingCooldown = 2;
      }
    }

    if(skill.id === 'regen'){
      const candidates = ['left','right'].filter(k => toNum(gameState.enemy[k]) > 0 && toNum(gameState.enemy[k]) < MAX_VALUE);
      for(let i=0;i<skill.level;i++){
        if(candidates.length === 0) break;
        const r = candidates[rand(0,candidates.length-1)];
        gameState.enemy[r] = Math.min(MAX_VALUE, toNum(gameState.enemy[r]) + 1);
        const el = hands[r === 'left' ? 'enemyLeft' : 'enemyRight'];
        showDamage(el, 1, '#ff9e9e');
      }
      // regen passive-like: no cooldown
    }

    if(skill.id === 'fortify' && Math.random() < 0.25){
      const duration = 2 * skill.level;
      applyEnemyTurnBuff('fortify', skill.level, duration);
      messageArea.textContent = `敵が ${skill.name} を構えた（防御+${skill.level} / ${duration}ターン）`;
      playSE('skill', 0.6);
      skill.remainingCooldown = 3;
    }

    if(skill.id === 'chain' && Math.random() < 0.25){
      applyEnemyTurnBuff('chain', skill.level, 1);
      const tb = gameState.enemyTurnBuffs[gameState.enemyTurnBuffs.length - 1];
      if(tb) tb.payload = { type:'chainBoost', value: skill.level };
      playSE('skill', 0.6);
      skill.remainingCooldown = 2;
    }
  });

  updateEnemySkillUI();

  // --- attack ---
  const from = aliveEnemy[rand(0,aliveEnemy.length-1)];
  const to = alivePlayer[rand(0,alivePlayer.length-1)];

  const attackerEl = hands[from === 'left' ? 'enemyLeft' : 'enemyRight'];
  const targetEl = hands[to === 'left' ? 'playerLeft' : 'playerRight'];

  playSE('attack', 0.65);
  animateAttack(attackerEl, targetEl);

  let attackValue = toNum(gameState.enemy[from]);
  attackValue += computeEnemyAttackBonus(from);

  // reduce by player's guard/buffs
  const reduction = computeEnemyAttackReduction();
  attackValue = Math.max(0, attackValue - reduction);

  // multiplier from enemy double
  const multiplier = gameState.enemyDoubleMultiplier || 1;
  gameState.enemyDoubleMultiplier = 1;
  attackValue = attackValue * multiplier;

  // apply enemy chain buff if any
  gameState.enemyTurnBuffs.forEach(tb => {
    if(tb.payload && tb.payload.type === 'chainBoost') attackValue += tb.payload.value;
  });

  showDamage(targetEl, attackValue, '#ffb86b');

  let curPlayer = toNum(gameState.player[to]);
  let newVal = curPlayer + attackValue;
  if(!Number.isFinite(newVal)) newVal = 0;

  const destroyThreshold = getDestroyThreshold(false); // enemy attacker
  if(newVal >= destroyThreshold){
    newVal = 0;
    animateDestroy(targetEl);
    playSE('destroy', 0.9);
  } else {
    if(newVal > MAX_VALUE) newVal = MAX_VALUE;
  }

  gameState.player[to] = newVal;

  // enemy revenge handling (if assigned)
  (gameState.enemySkills || []).forEach(s => {
    if(s.id === 'revenge'){
      ['left','right'].forEach(side => {
        if(toNum(gameState.enemy[side]) === 0){
          const amount = s.level;
          gameState.enemy[side] = Math.min(MAX_VALUE, toNum(gameState.enemy[side]) + amount);
          const el = hands[side === 'left' ? 'enemyLeft' : 'enemyRight'];
          showDamage(el, amount, '#ff9e9e');
          messageArea.textContent = `敵の ${s.name} が発動した！`;
          playSE('skill', 0.7);
        }
      });
    }
  });

  // tick buffs and cooldowns
  tickTurnBuffs();
  tickEnemyTurnBuffs();

  gameState.playerTurn = true;
  updateUI();
  flashScreen();
  checkWinLose();
}

/* ---------- pending active ---------- */
function applyPendingActiveOnPlayerWrapper(side){
  applyPendingActiveOnPlayer(side);
}

/* ---------- helper ---------- */
function clearHandSelection(){
  selectedHand = null;
  if(hands.playerLeft) hands.playerLeft.classList.remove('selected');
  if(hands.playerRight) hands.playerRight.classList.remove('selected');
}

/* ---------- check win/lose & reward ---------- */
function checkWinLose(){
  const playerDead = toNum(gameState.player.left) === 0 && toNum(gameState.player.right) === 0;
  const enemyDead = toNum(gameState.enemy.left) === 0 && toNum(gameState.enemy.right) === 0;

  if(enemyDead){
    playSE('victory', 0.8);
    messageArea.textContent = 'Victory! スキル報酬を獲得';
    setTimeout(()=> showRewardSelection(), 600);
    return true;
  }
  if(playerDead){
    playSE('lose', 0.8);
    messageArea.textContent = 'Game Over';
    if(gameState.stage > gameState.bestStage){
      gameState.bestStage = gameState.stage;
      saveBest();
    }
    setTimeout(()=> {
      bestStageValue.textContent = gameState.bestStage;
      showTitle();
    }, 1000);
    return true;
  }
  return false;
}

/* ---------- reward selection (unchanged) ---------- */
function showRewardSelection(){
  const unlockedIds = (gameState.unlockedSkills || []).map(u=>u.id);
  const notUnlocked = SKILL_POOL.filter(s => !unlockedIds.includes(s.id));
  const upgradeCandidates = gameState.unlockedSkills.slice().map(u => ({ id: u.id, level: u.level, upgrade:true }));

  const pool = [];
  pool.push(...notUnlocked.sort(()=>0.5-Math.random()).slice(0,3).map(s=>({ id: s.id, isNew:true })));
  if(pool.length < 3){
    const needed = 3 - pool.length;
    pool.push(...upgradeCandidates.sort(()=>0.5-Math.random()).slice(0,needed).map(u=>({ id: u.id, isUpgrade:true })));
  } else {
    if(upgradeCandidates.length > 0 && Math.random() < 0.5){
      const replaceIdx = rand(0, pool.length-1);
      pool[replaceIdx] = { id: upgradeCandidates[0].id, isUpgrade:true };
    }
  }

  if(pool.length === 0){
    if(gameState.unlockedSkills.length > 0) pool.push({ id: gameState.unlockedSkills[0].id, isUpgrade:true });
  }

  skillSelectArea.innerHTML = '';
  messageArea.textContent = '報酬スキルを1つ選んでください（永久アンロック / アップグレード）';
  const wrap = document.createElement('div'); wrap.className = 'skill-choices';

  pool.forEach(p => {
    const def = SKILL_POOL.find(s=>s.id===p.id);
    if(!def) return;
    const unlockedObj = gameState.unlockedSkills.find(u=>u.id===p.id);
    const label = p.isUpgrade ? `${def.name} を上昇 (現在 Lv${unlockedObj.level})` : `${def.name} をアンロック`;
    const btn = document.createElement('button');
    btn.className = 'skill-btn';
    btn.innerHTML = `<div style="font-weight:700">${label}</div><small style="opacity:.9">${def.baseDesc}</small>`;
    btn.onclick = () => {
      playSE('click', 0.5);
      if(p.isUpgrade && unlockedObj){
        unlockedObj.level = Math.min(MAX_SKILL_LEVEL, (unlockedObj.level || 1) + 1);
        messageArea.textContent = `${def.name} を Lv${unlockedObj.level} に強化しました`;
      } else {
        gameState.unlockedSkills.push({ id: def.id, level: 1 });
        messageArea.textContent = `${def.name} をアンロックしました！`;
      }
      saveUnlocked();
      renderUnlockedList();
      skillSelectArea.innerHTML = '';
      flashScreen(.14);
      setTimeout(()=> {
        gameState.stage++;
        startBattle();
      }, 700);
    };
    wrap.appendChild(btn);
  });

  skillSelectArea.appendChild(wrap);
}

/* ---------- click handlers ---------- */
function selectHand(side){
  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'heal'){
    applyPendingActiveOnPlayerWrapper(side);
    return;
  }
  if(skillSelectArea && skillSelectArea.children.length > 0){
    messageArea.textContent = 'まず装備を確定してください'; return;
  }
  if(!gameState.playerTurn) return;
  if(toNum(gameState.player[side]) === 0) return;

  playSE('click', 0.5);

  selectedHand = side;
  if(hands.playerLeft) hands.playerLeft.classList.toggle('selected', side === 'left');
  if(hands.playerRight) hands.playerRight.classList.toggle('selected', side === 'right');

  messageArea.textContent = '敵の手を選んで攻撃してください';
}
function clickEnemyHand(side){
  if(skillSelectArea && skillSelectArea.children.length > 0){ messageArea.textContent = 'まず装備を確定してください'; return; }
  if(!gameState.playerTurn) return;
  if(!selectedHand){ messageArea.textContent = '攻撃する手を選んでください'; return; }
  if(toNum(gameState.enemy[side]) === 0){ messageArea.textContent = 'その敵の手は既に0です'; return; }

  playSE('click', 0.5);
  playerAttack(side);
}

/* attach once */
hands.playerLeft.onclick = () => selectHand('left');
hands.playerRight.onclick = () => selectHand('right');
hands.enemyLeft.onclick = () => clickEnemyHand('left');
hands.enemyRight.onclick = () => clickEnemyHand('right');

/* ---------- start ---------- */
initGame();

/* expose for debugging */
window.__FD = {
  state: gameState,
  saveUnlocked,
  loadUnlocked,
  SKILL_POOL,
  getUnlockedLevel,
  commitEquips: ()=>commitEquips(),
  renderEquipped,
  renderUnlockedList,
  assignEnemySkills
};
