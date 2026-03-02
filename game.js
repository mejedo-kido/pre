/* game.js — 完全版（修正版: possession 発動修正 / reincarnation 改良 / fortress を閾値×2 に変更）
   変更点:
   - startBattle での possession 適用を取り除き、commitEquips() 後に applyBattleStartPassives() を呼ぶように変更
   - BOSS_ABILITIES.reincarnation を onHandDestroyed 実装に変更（破壊後に mod(maxFinger) で復活）
   - fortress は bossEnemyThresholdMultiplier = 2（閾値×2）に変更
   - baseStats.maxFinger を導入（デフォルト 5）
   - gameState.awaitingEquip フラグで「戦闘開始→装備選択→装備確定」の順を保証
*/

const STORAGE_KEY = 'fd_unlocked_skills_v2';
const BEST_KEY = 'fd_best_stage_v1';
const EQUIP_SLOTS = 3;
const MAX_SKILL_LEVEL = 3;
const SKILL_LEVEL_CAP = { power: 2, possession: 1, split: 1 }; // possession / split は Lv1限定
const HARD_CAP = 99;

/* ---------- SKILL POOL ---------- */
const SKILL_POOL = [
  { id:'power',     type:'passive', baseDesc:'攻撃 +1 / level',                  name:'💥 パワーアップ', rarity:'rare'  },
  { id:'guard',     type:'passive', baseDesc:'敵攻撃 -1 / level',                 name:'🛡 ガード',       rarity:'common'},
  { id:'berserk',   type:'passive', baseDesc:'自分の手が4のとき攻撃 +level (×2)', name:'⚡ バーサーク',   rarity:'common'},
  { id:'regen',     type:'turn',    baseDesc:'敵ターン後に自分のランダムな手 -1 ×level', name:'💚 リジェネ', rarity:'common'},
  { id:'double',    type:'active',  baseDesc:'次の攻撃が (1 + level) 倍',          name:'⛏ ダブルストライク', rarity:'epic'},
  { id:'heal',      type:'active',  baseDesc:'自分の手を - (1 + level)',          name:'✨ ヒール（自傷）', rarity:'rare'  },
  { id:'pierce',    type:'passive', baseDesc:'相手の指の最大値を -level（最小2）',        name:'🔩 ピアス',       rarity:'epic'  },
  { id:'chain',     type:'combo',   baseDesc:'敵手を破壊した次の攻撃 +level',    name:'🔗 チェイン',     rarity:'common'},
  { id:'fortify',   type:'turn',    baseDesc:'自分の防御+1 for 2 turns ×level',  name:'🏰 フォーティファイ', rarity:'rare'},
  { id:'revenge',   type:'event',   baseDesc:'自分の手が0になったら即ヒール +level', name:'🔥 リベンジ', rarity:'rare'},
  { id:'disrupt',   type:'active',  baseDesc:'敵の手を -(1+level)', name:'🪓 ディスラプト', rarity:'common'},
  { id:'teamPower', type:'turn',    baseDesc:'味方全体の攻撃 +level（2*levelターン）', name:'🌟 チームパワー', rarity:'rare'},
  { id:'counter',   type:'event',   baseDesc:'攻撃を受けた時、相手の手を +level して反撃', name:'↺ カウンター', rarity:'common'},

  // 新規追加スキル
  { id:'overheat',  type:'active',  baseDesc:'自身の手 +3、さらにシールド +level', name:'🔥 オーバーヒート', rarity:'rare'},
  { id:'pumpUp',    type:'active',  baseDesc:'自身の手 +level',                  name:'💪 パンプアップ', rarity:'common'},
  { id:'possession',type:'passive', baseDesc:'バトル開始時:、左手0にし、基礎能力2倍（バトル中）', name:'🕯 ポゼッション', rarity:'epic'},
  { id:'split',     type:'active',  baseDesc:'片手のみ生存かつ値≥2の時、その手を半分に分割して両手にする', name:'✂ 分割', rarity:'common'}
];

/* ---------- BOSS ABILITIES ---------- */
const BOSS_ABILITIES = [
  {
    id: 'reincarnation',
    name: '♻ 転生',
    desc: '一度破壊された後、(破壊直前値 % 指の最大値) で復活（mod=0 の場合はそのまま破壊）',
    // called after hand was set to 0 (破壊された後)
    onHandDestroyed(side, attemptedValue){
      try {
        const maxFinger = getMaxFingerForEnemy(); // 敵側の指の最大値（通常は baseStats.maxFinger）
        let mod = attemptedValue % maxFinger;
        if(mod !== 0){
          gameState.enemy[side] = mod;
          const el = hands[ side === 'left' ? 'enemyLeft' : (side === 'right' ? 'enemyRight' : 'enemyThird') ];
          if(el) showPopupText(el, `復活 ${mod}`, '#ffd166');
          messageArea.textContent = `ボスの ${this.name} が発動！手が ${mod} に復活`;
        } else {
          // remain destroyed (0) - do nothing
        }
      } catch(e){}
    }
  },
  {
    id: 'split',
    name: '✂ 分割',
    desc: '片手のみ生存で値が2以上なら、次の敵ターン開始時に分裂する',
    onEnemyTurnStart(){
      const keys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
      const alive = keys.filter(s => toNum(gameState.enemy[s]) > 0);
      if(alive.length === 1){
        const side = alive[0];
        const val = toNum(gameState.enemy[side]);
        if(val >= 2){
          const half1 = Math.floor(val / 2);
          const half2 = Math.ceil(val / 2);
          gameState.enemy.left = half1;
          gameState.enemy.right = half2;
          if(gameState.enemyHasThirdHand) gameState.enemy.third = 0;
          messageArea.textContent = `ボスの ${this.name}：分裂が発生しました`;
          flashScreen(.12);
        }
      }
    }
  },
  {
    id: 'thirdHand',
    name: '🖐 第三の手',
    desc: '戦闘開始時に第三の手が出現する（初期値1）',
    apply(){
      gameState.enemyHasThirdHand = true;
      gameState.enemy.third = 1;
    }
  },
  {
    id: 'fortress',
    name: '🛡 超耐久',
    desc: '敵の指の最大値が ×2 される（ボス戦中のみ有効）',
    apply(){
      // set multiplier to 2 (can stack if desired)
      gameState.bossEnemyThresholdMultiplier = (gameState.bossEnemyThresholdMultiplier || 1) * 2;
    }
  },
  {
    id: 'timeLimit',
    name: '⏳ タイムリミット',
    desc: '6ターン以内に倒さないと強制敗北',
    apply(){
      gameState.bossTurnCount = 6;
    },
    onPlayerTurnEnd(){
      if(typeof gameState.bossTurnCount !== 'number') gameState.bossTurnCount = 6;
      gameState.bossTurnCount = Math.max(0, gameState.bossTurnCount - 1);
      messageArea.textContent = `タイムリミット：残り ${gameState.bossTurnCount} ターン`;
      if(gameState.bossTurnCount <= 0){
        forceLose();
      }
    }
  }
];

/* ---------- game state ---------- */
const gameState = {
  stage: 1,
  isBoss: false,
  floor: 1,
  player: { left: 1, right: 1 },
  enemy: { left: 1, right: 1 },
  playerTurn: true,
  unlockedSkills: [],
  equippedSkills: [],
  pendingActiveUse: null,
  doubleMultiplier: 1,
  turnBuffs: [],
  enemySkills: [],
  enemyDoubleMultiplier: 1,
  enemyTurnBuffs: [],
  bestStage: 1,
  inTitle: true,
  combo: 0,
  baseStats: {
    playerThreshold: 5,
    enemyThreshold: 5,
    baseAttack: 0,
    baseDefense: 0,
    maxFinger: 5 // ← 指の最大値（デフォルト5, 将来可変化可能）
  },
  inBossReward: false,
  bossAbility: null,
  bossTurnCount: 0,
  enemyHasThirdHand: false,
  // boss 用閾値倍率（1がデフォルト）
  bossEnemyThresholdMultiplier: 1,

  // --- 新: プレイヤーの戦闘限定修飾（ポゼッション用など）
  playerBattleModifiers: {
    thresholdMultiplier: 1,
    attackMultiplier: 1,
    defenseMultiplier: 1
  },

  // --- 新: プレイヤー用シールド（オーバーヒートで付与）
  playerShield: 0,

  // --- フラグ：startBattle 後に装備選択を待っているか
  awaitingEquip: false
};

let selectedHand = null;
let equipTemp = [];
let _overlayEl = null;

/* ---------- DOM ---------- */
const titleScreen = document.getElementById('titleScreen');
const ruleScreen = document.getElementById('ruleScreen');
const startButton = document.getElementById('startButton');
const resetButton = document.getElementById('resetButton');
const ruleNextButton = document.getElementById('ruleNextButton');
const ruleBackButton = document.getElementById('ruleBackButton');
const bestStageValue = document.getElementById('bestStageValue');

const stageInfo = document.getElementById('stageInfo');
const skillInfo = document.getElementById('skillInfo') || (() => { const el=document.createElement('div'); el.id='skillInfo'; document.querySelector('.container').prepend(el); return el; })();
const thresholdInfo = document.getElementById('thresholdInfo');
const messageArea = document.getElementById('message');
const skillSelectArea = document.getElementById('skillSelectArea');
const equippedList = document.getElementById('equippedList');
const unlockedList = document.getElementById('unlockedList');
const flashLayer = document.getElementById('flashLayer');

const enemySkillArea = document.getElementById('enemySkillArea');
const bossAbilityArea = document.getElementById('bossAbilityArea');

const hands = {
  playerLeft: document.getElementById('player-left'),
  playerRight: document.getElementById('player-right'),
  enemyLeft: document.getElementById('enemy-left'),
  enemyRight: document.getElementById('enemy-right'),
  enemyThird: document.getElementById('enemy-third')
};

const bars = {
  playerLeft: document.getElementById('player-left-bar'),
  playerRight: document.getElementById('player-right-bar'),
  enemyLeft: document.getElementById('enemy-left-bar'),
  enemyRight: document.getElementById('enemy-right-bar'),
  enemyThird: document.getElementById('enemy-third-bar')
};

/* ---------- SE ---------- */
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
  gameState.baseStats = { playerThreshold:5, enemyThreshold:5, baseAttack:0, baseDefense:0, maxFinger:5 };
  gameState.inBossReward = false;
  gameState.bossAbility = null;
  gameState.bossTurnCount = 0;
  gameState.enemyHasThirdHand = false;
  gameState.bossEnemyThresholdMultiplier = 1;

  // reset Player battle modifiers & shield
  gameState.playerBattleModifiers = { thresholdMultiplier:1, attackMultiplier:1, defenseMultiplier:1 };
  gameState.playerShield = 0;
  gameState.awaitingEquip = false;

  selectedHand = null;
  equipTemp = [];
  removeOverlay();

  if(unlockedList) unlockedList.style.display = 'none';

  if(equippedList) equippedList.innerHTML = '';
  messageArea.textContent = 'スキルをリセットしました（初期スキルに戻しました）';
  showTitle();
}

/* ---------- helper utilities ---------- */
function safeDecrease(cur, amount){
  cur = toNum(cur);
  if(cur === 0) return 0;
  let newVal = cur - amount;
  if(newVal < 1) newVal = 1;
  return newVal;
}

function getSkillLevelOnUnit(isEnemy, skillId){
  if(isEnemy){
    if(!gameState.enemySkills) return 0;
    const s = gameState.enemySkills.find(x=>x.id===skillId);
    return s ? (s.level||1) : 0;
  } else {
    const s = (gameState.equippedSkills || []).find(x=>x.id===skillId);
    return s ? (s.level||1) : 0;
  }
}

function computeDefenseForTarget(targetIsEnemy){
  let reduction = 0;
  if(targetIsEnemy){
    (gameState.enemySkills || []).forEach(s => { if(s.id === 'guard') reduction += s.level; });
    (gameState.enemyTurnBuffs || []).forEach(tb => {
      if(tb.payload && (tb.payload.type === 'enemyGuardBoost' || tb.payload.type === 'guardBoost')) reduction += tb.payload.value;
    });
  } else {
    (gameState.equippedSkills || []).forEach(s => { if(s.id === 'guard') reduction += s.level; });
    (gameState.turnBuffs || []).forEach(tb => { if(tb.payload && tb.payload.type === 'guardBoost') reduction += tb.payload.value; });
  }
  return reduction;
}

function handleCounter(attackerIsEnemy, attackerSide, targetIsEnemy, targetSide){
  const counterLevel = getSkillLevelOnUnit(targetIsEnemy, 'counter');
  if(!counterLevel || counterLevel <= 0) return;

  if(attackerIsEnemy){
    const cur = toNum(gameState.enemy[attackerSide]);
    const newVal = Math.min(HARD_CAP, cur + counterLevel);
    gameState.enemy[attackerSide] = newVal;
    const el = hands[ attackerSide === 'left' ? 'enemyLeft' : (attackerSide === 'right' ? 'enemyRight' : 'enemyThird') ];
    showPopupText(el, `+${counterLevel}`, '#ffd166');
  } else {
    const cur = toNum(gameState.player[attackerSide]);
    const newVal = Math.min(HARD_CAP, cur + counterLevel);
    gameState.player[attackerSide] = newVal;
    const el = hands[ attackerSide === 'left' ? 'playerLeft' : 'playerRight' ];
    showPopupText(el, `+${counterLevel}`, '#ffd166');
  }
  messageArea.textContent = `カウンター発動！攻撃者に +${counterLevel}`;
}

/* ---------- init & title handling ---------- */
function initGame(){
  const loaded = loadUnlocked();
  if(loaded && loaded.length>0) gameState.unlockedSkills = loaded;
  else seedInitialUnlocks();

  gameState.bestStage = loadBest();
  if(bestStageValue) bestStageValue.textContent = gameState.bestStage;

  if(titleScreen) titleScreen.style.display = 'flex';
  if(ruleScreen) ruleScreen.style.display = 'none';
  if(skillSelectArea) skillSelectArea.innerHTML = '';
  if(enemySkillArea) enemySkillArea.innerHTML = '敵スキル: —';
  messageArea.textContent = '';

  if(unlockedList) unlockedList.style.display = 'none';

  startButton.onclick = () => { playSE('click', 0.5); if(ruleScreen) ruleScreen.style.display = 'flex'; };
  resetButton.onclick = () => { playSE('click', 0.5); resetGame(); };
  if(ruleNextButton) ruleNextButton.onclick = () => { playSE('click', 0.5); if(ruleScreen) ruleScreen.style.display = 'none'; startGame(); };
  if(ruleBackButton) ruleBackButton.onclick = () => { playSE('click', 0.5); if(ruleScreen) ruleScreen.style.display = 'none'; if(titleScreen) titleScreen.style.display = 'flex'; };

  if(hands.playerLeft) hands.playerLeft.onclick = () => selectHand('left');
  if(hands.playerRight) hands.playerRight.onclick = () => selectHand('right');
  if(hands.enemyLeft) hands.enemyLeft.onclick = () => clickEnemyHand('left');
  if(hands.enemyRight) hands.enemyRight.onclick = () => clickEnemyHand('right');
  if(hands.enemyThird) hands.enemyThird.onclick = () => clickEnemyHand('third');

  setupHoverHandlers();
}

function showTitle(){ gameState.inTitle = true; if(titleScreen) titleScreen.style.display = 'flex'; if(bestStageValue) bestStageValue.textContent = gameState.bestStage; }
function hideTitle(){ gameState.inTitle = false; if(titleScreen) titleScreen.style.display = 'none'; }

/* ---------- helpers for max finger ---------- */
function getMaxFingerForEnemy(){
  return (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.maxFinger))) ? Number(gameState.baseStats.maxFinger) : 5;
}
function getMaxFingerForPlayer(){
  return (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.maxFinger))) ? Number(gameState.baseStats.maxFinger) : 5;
}

/* ---------- start / stage flow ---------- */
function startGame(){
  gameState.baseStats = { playerThreshold:5, enemyThreshold:5, baseAttack:0, baseDefense:0, maxFinger:5 };
  gameState.inBossReward = false;

  gameState.stage = 1;
  gameState.playerTurn = true;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.turnBuffs = [];
  gameState.enemyTurnBuffs = [];
  gameState.enemySkills = [];
  gameState.enemyDoubleMultiplier = 1;
  gameState.equippedSkills = [];
  gameState.combo = 0;

  // reset player modifiers & shield
  gameState.playerBattleModifiers = { thresholdMultiplier:1, attackMultiplier:1, defenseMultiplier:1 };
  gameState.playerShield = 0;
  gameState.awaitingEquip = false;

  selectedHand = null;
  equipTemp = [];

  if(titleScreen) titleScreen.style.display = 'none';
  if(ruleScreen) ruleScreen.style.display = 'none';

  if(skillSelectArea) skillSelectArea.innerHTML = '';
  if(messageArea) messageArea.textContent = '';
  if(enemySkillArea) enemySkillArea.innerHTML = '敵スキル: —';

  if(!gameState.unlockedSkills || gameState.unlockedSkills.length === 0) seedInitialUnlocks();

  startBattle();
}

function startBattle(){
  if(gameState.inBossReward) return;

  // reset boss temporary values at battle start so they won't leak
  gameState.bossEnemyThresholdMultiplier = 1;
  gameState.bossAbility = null;
  gameState.bossTurnCount = 0;
  gameState.enemyHasThirdHand = false;

  // reset player temporary modifiers each battle
  gameState.playerBattleModifiers = { thresholdMultiplier:1, attackMultiplier:1, defenseMultiplier:1 };
  gameState.playerShield = 0;

  equipTemp = [];
  selectedHand = null;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.equippedSkills = [];
  gameState.turnBuffs = [];
  gameState.playerTurn = true;
  gameState.combo = 0;

  gameState.player.left = 1;
  gameState.player.right = 1;

  gameState.isBoss = (gameState.stage % 3 === 0);
  document.body.classList.toggle('boss', gameState.isBoss);

  gameState.enemy.left = toNum(rand(1,2));
  gameState.enemy.right = toNum(rand(1,2));

  gameState.enemyDoubleMultiplier = 1;
  gameState.enemyTurnBuffs = [];

  if(gameState.isBoss){
    assignBossAbility();
  }

  assignEnemySkills();

  // フラグを立てて「装備選択待ち」にする
  gameState.awaitingEquip = true;

  updateUI();
  showEquipSelection();
}

/* ---------- assign enemy skills ---------- */
function assignEnemySkills(){
  const possible = SKILL_POOL.slice().filter(s => s.id !== 'revenge');
  const skillCount = Math.min(3, 1 + Math.floor(gameState.stage / 4));
  const chosen = [];
  let pool = possible.slice();
  while(chosen.length < skillCount && pool.length > 0){
    const idx = rand(0, pool.length - 1);
    const s = pool.splice(idx, 1)[0];
    const level = Math.min(MAX_SKILL_LEVEL, 1 + Math.floor(gameState.stage / 6));
    chosen.push({ id: s.id, level, type: s.type, name: s.name, remainingCooldown: 0 });
  }
  gameState.enemySkills = chosen;
  updateEnemySkillUI();
}

/* ---------- apply battle-start passives (called after commitEquips if awaitingEquip) ---------- */
function applyBattleStartPassives(){
  if(!gameState.awaitingEquip) return;
  gameState.awaitingEquip = false; // 一度だけ適用

  // possession: equipしていれば左手を破壊、戦闘修飾を×2
  if(hasEquipped('possession')){
    // apply only once
    gameState.player.left = 0;
    gameState.playerBattleModifiers.thresholdMultiplier = 2;
    gameState.playerBattleModifiers.attackMultiplier = 2;
    gameState.playerBattleModifiers.defenseMultiplier = 2;
    messageArea.textContent = 'ポゼッションが発動：左手を失い、基礎値が×2に';
    playSE('skill', 0.6);
    flashScreen(.14);
  }
}

/* ---------- equip / reward UI ---------- */
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
    btn.classList.add('rarity-' + (def.rarity || 'common'));
    btn.dataset.id = us.id;
    btn.innerHTML = `<div style="font-weight:700">${def.name} Lv${us.level}</div><small style="opacity:.9">${def.baseDesc}</small><div style="font-size:11px;opacity:.85;margin-top:4px">${(def.rarity||'common').toUpperCase()}</div>`;
    btn.onclick = () => {
      if(gameState.inBossReward) return;
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
  confirm.onclick = () => {
    if(gameState.inBossReward) return;
    playSE('click', 0.5);
    commitEquips();
  };

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
  skillInfo.textContent = gameState.equippedSkills && gameState.equippedSkills.length ? 'Equipped: ' + gameState.equippedSkills.map(s=>s.name+' Lv'+s.level).join(', ') : 'Equipped: —';

  // 装備確定後にバトル開始時パッシブを適用（possession 等）
  applyBattleStartPassives();

  // UI 更新（閾値表示等が変わるため）
  updateUI();
}

/* ---------- rendering ---------- */
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
        if(gameState.inBossReward) return;
        if(s.used) return;
        playSE('skill', 0.7);
        // existing actives
        if(s.id === 'double'){
          s.used = true;
          gameState.doubleMultiplier = 1 + s.level;
          messageArea.textContent = `${s.name} を発動（次の攻撃が×${gameState.doubleMultiplier}）`;
          renderEquipped();
        } else if(s.id === 'heal'){
          gameState.pendingActiveUse = { id: 'heal', idx };
          messageArea.textContent = 'ヒール使用：自分の手を選んでください';
        } else if(s.id === 'disrupt'){
          gameState.pendingActiveUse = { id: 'disrupt', idx };
          messageArea.textContent = 'ディスラプト使用：敵の手を選んでください';
        } else if(s.id === 'teamPower'){
          s.used = true;
          const duration = 2 * s.level;
          s.remainingTurns = duration;
          applyTurnBuff('teamPower', s.level, duration);
          messageArea.textContent = `${s.name} を ${duration} ターン有効化しました（味方全体の攻撃 +${s.level}）`;
          renderEquipped();
        } else if(s.type === 'turn'){
          s.used = true;
          const duration = 2 * s.level;
          s.remainingTurns = duration;
          applyTurnBuff(s.id, s.level, duration);
          messageArea.textContent = `${s.name} を ${duration} ターン有効化しました`;
          renderEquipped();
        } else {
          // 新規アクティブスキル：overheat / pumpUp / split
          if(s.id === 'overheat'){
            gameState.pendingActiveUse = { id: 'overheat', idx };
            messageArea.textContent = 'オーバーヒート使用：自分の手を選んでください（+3、シールド+Lv）';
          } else if(s.id === 'pumpUp'){
            gameState.pendingActiveUse = { id: 'pumpUp', idx };
            messageArea.textContent = 'パンプアップ使用：自分の手を選んでください（+Lv）';
          } else if(s.id === 'split'){
            // split は片手選択で動作する（片手のみ生存でかつ値>=2 の場合のみ成功）
            gameState.pendingActiveUse = { id: 'split', idx };
            messageArea.textContent = '分割使用：片手のみ生存の時に、その手を選んでください（分割されます）';
          } else {
            messageArea.textContent = 'このタイプのスキルはまだ実装されていません';
          }
        }
      };
      const div = document.createElement('div');
      div.className = 'skill-active';
      if(s.remainingTurns && s.remainingTurns > 0){
        const meta = document.createElement('div');
        meta.style.fontSize = '12px';
        meta.style.opacity = '0.9';
        meta.textContent = `(${s.remainingTurns}ターン)`;
        card.appendChild(meta);
      }
      div.appendChild(btn);
      card.appendChild(div);
    }
    equippedList.appendChild(card);
  });
}

function renderUnlockedList(){
  if(unlockedList) {
    unlockedList.style.display = 'none';
  }
}

/* ---------- enemy skill UI ---------- */
function updateEnemySkillUI(){
  if(!enemySkillArea) return;
  if(!gameState.enemySkills || gameState.enemySkills.length === 0){
    enemySkillArea.textContent = '敵スキル: —';
    return;
  }

  const typeColor = {
    passive: '#ddd',
    active: '#ffd166',
    turn: '#7cc7ff',
    combo: '#d7b3ff',
    event: '#ff9e9e'
  };

  const parts = gameState.enemySkills.map(s => {
    const cd = s.remainingCooldown && s.remainingCooldown > 0 ? ` (CD:${s.remainingCooldown})` : '';
    const color = typeColor[s.type] || '#fff';
    const def = SKILL_POOL.find(x=>x.id===s.id) || {};
    const rar = def.rarity ? ` [${def.rarity.toUpperCase()}]` : '';
    return `<span style="color:${color}; font-weight:700; margin-right:6px">${s.name}${rar} Lv${s.level}${cd}</span>`;
  });

  const buffs = gameState.enemyTurnBuffs.map(tb => {
    if(tb.skillId === 'fortify') return `防御+${tb.payload.value} (${tb.remainingTurns})`;
    if(tb.skillId === 'chain') return `次攻撃+${tb.payload.value} (${tb.remainingTurns})`;
    if(tb.skillId === 'teamPower') return `味方全体+${tb.payload.value} (${tb.remainingTurns})`;
    return '';
  }).filter(Boolean);

  const buffText = buffs.length ? ` | Buffs: ${buffs.join(', ')}` : '';
  enemySkillArea.innerHTML = `敵スキル: ${parts.join(' ')}${buffText}`;
}

/* ---------- UI update ---------- */
function updateBossUI(){
  if(!bossAbilityArea) return;
  if(!gameState.isBoss || !gameState.bossAbility){
    bossAbilityArea.textContent = '';
    return;
  }
  bossAbilityArea.innerHTML = `<span style="color:#ff5555;font-weight:bold">BOSS能力: ${gameState.bossAbility.name}</span><br><small>${gameState.bossAbility.desc}</small>`;
}

function updateUI(){
  const pThreshold = (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.playerThreshold)))
    ? Number(gameState.baseStats.playerThreshold)
    : 5;
  stageInfo.textContent = `Stage ${gameState.stage} ${gameState.isBoss ? 'BOSS' : ''}`;

  // 表示用に player 側の閾値に battle modifier と boss multiplier（敵の超耐久は敵側に適用される）を適用
  let displayPThresh = pThreshold * (gameState.playerBattleModifiers && gameState.playerBattleModifiers.thresholdMultiplier ? gameState.playerBattleModifiers.thresholdMultiplier : 1);
  if(thresholdInfo) thresholdInfo.textContent = `Threshold: ${displayPThresh}`;

  skillInfo.textContent = gameState.equippedSkills && gameState.equippedSkills.length ? 'Equipped: ' + gameState.equippedSkills.map(s=>s.name+' Lv'+s.level).join(', ') : 'Equipped: —';
  updateHand('playerLeft', gameState.player.left);
  updateHand('playerRight', gameState.player.right);
  updateHand('enemyLeft', gameState.enemy.left);
  updateHand('enemyRight', gameState.enemy.right);
  if(gameState.enemyHasThirdHand){
    updateHand('enemyThird', gameState.enemy.third || 0);
  }
  updateEnemySkillUI();
  updateBossUI();

  if(_overlayEl && _overlayEl.dataset.owner && _overlayEl.dataset.hand) {
    refreshOverlayContent(_overlayEl.dataset.owner, _overlayEl.dataset.hand);
  }
}

function updateHand(key, value){
  const el = hands[key];
  const bar = bars[key];
  const v = toNum(value);
  if(el) { el.textContent = v; el.classList.toggle('zero', v === 0); }

  let displayThreshold = 5;
  if(key.startsWith('player')) displayThreshold = (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.playerThreshold))) ? Number(gameState.baseStats.playerThreshold) : 5;
  else {
    displayThreshold = (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.enemyThreshold))) ? Number(gameState.baseStats.enemyThreshold) : 5;
    // apply boss enemy threshold multiplier for display
    displayThreshold *= (gameState.bossEnemyThresholdMultiplier || 1);
  }

  // apply player battle modifier to displayed player threshold for UI only
  if(key.startsWith('player')){
    displayThreshold *= (gameState.playerBattleModifiers && gameState.playerBattleModifiers.thresholdMultiplier) ? gameState.playerBattleModifiers.thresholdMultiplier : 1;
  }

  if(bar) {
    const pct = displayThreshold > 0 ? Math.min(100, (v / displayThreshold) * 100) : Math.min(100, v * 16);
    bar.style.width = pct + '%';
  }
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
  d.textContent = (val >= 0 ? `+${val}` : `${val}`);
  d.style.color = color;
  targetEl.appendChild(d);
  setTimeout(()=> d.remove(), 820);
}
function showPopupText(targetEl, text, color='#fff'){
  if(!targetEl) return;
  const d = document.createElement('div');
  d.className = 'damage';
  d.textContent = text;
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
  else if(skillId === 'teamPower') payload = { type:'teamPower', value: level };
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
  else if(skillId === 'teamPower') payload = { type:'teamPower', value: level };
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
    if(s.id === 'berserk' && toNum(gameState.player[handKey]) === 4) bonus += s.level * 2;
  });
  gameState.turnBuffs.forEach(tb => {
    if(tb.payload){
      if(tb.payload.type === 'chainBoost') bonus += tb.payload.value;
      if(tb.payload.type === 'teamPower') bonus += tb.payload.value;
    }
  });
  // apply baseAttack * player battle attack multiplier
  const baseAtk = (gameState.baseStats && gameState.baseStats.baseAttack) ? Number(gameState.baseStats.baseAttack) : 0;
  const atkMul = (gameState.playerBattleModifiers && gameState.playerBattleModifiers.attackMultiplier) ? gameState.playerBattleModifiers.attackMultiplier : 1;
  bonus += baseAtk * atkMul;
  return bonus;
}
function computeEnemyAttackBonus(attackerHandKey){
  let bonus = 0;
  (gameState.enemySkills || []).forEach(s => {
    if(s.type !== 'passive') return;
    if(s.id === 'power') bonus += s.level;
    if(s.id === 'berserk' && toNum(gameState.enemy[attackerHandKey]) === 4) bonus += s.level * 2;
  });
  gameState.enemyTurnBuffs.forEach(tb => {
    if(tb.payload && tb.payload.type === 'chainBoost') bonus += tb.payload.value;
    if(tb.payload && tb.payload.type === 'teamPower') bonus += tb.payload.value;
  });
  return bonus;
}
function computeEnemyAttackReduction(){
  let reduction = 0;
  (gameState.equippedSkills || []).forEach(s => {
    if(s.type === 'passive' && s.id === 'guard') reduction += s.level;
  });
  gameState.turnBuffs.forEach(tb => { if(tb.payload && tb.payload.type === 'guardBoost') reduction += tb.payload.value; });
  return reduction;
}

/* ---------- destroy threshold (attacker-aware, with multipliers) ---------- */
function getDestroyThreshold(attackerIsPlayer = true){
  const targetIsEnemy = attackerIsPlayer === true;
  let thresholdRaw = targetIsEnemy
    ? (Number.isFinite(Number(gameState.baseStats.enemyThreshold)) ? Number(gameState.baseStats.enemyThreshold) : 5)
    : (Number.isFinite(Number(gameState.baseStats.playerThreshold)) ? Number(gameState.baseStats.playerThreshold) : 5);

  // apply boss temporary multiplier for enemy target
  if(targetIsEnemy) thresholdRaw = thresholdRaw * (gameState.bossEnemyThresholdMultiplier || 1);

  // apply player-side battle modifier when target is player
  if(!targetIsEnemy){
    const mul = (gameState.playerBattleModifiers && gameState.playerBattleModifiers.thresholdMultiplier) ? gameState.playerBattleModifiers.thresholdMultiplier : 1;
    thresholdRaw = thresholdRaw * mul;
  }

  let threshold = Number(thresholdRaw);
  if(!Number.isFinite(threshold)) threshold = 5;

  // apply pierce reductions from attacker's side
  if(attackerIsPlayer){
    (gameState.equippedSkills || []).forEach(s => {
      if(s.type === 'passive' && s.id === 'pierce') threshold = Math.max(2, threshold - Number(s.level || 0));
    });
  } else {
    (gameState.enemySkills || []).forEach(s => {
      if(s.type === 'passive' && s.id === 'pierce') threshold = Math.max(2, threshold - Number(s.level || 0));
    });
  }
  if(!Number.isFinite(threshold)) threshold = 5;
  threshold = Math.max(2, threshold);
  return threshold;
}

/* ---------- helper: apply regen to a specific unit (self-only) ---------- */
function applyRegenToUnit(isEnemy, level){
  const targetObj = isEnemy ? gameState.enemy : gameState.player;
  let sides = ['left','right'];
  if(isEnemy && gameState.enemyHasThirdHand) sides.push('third');
  sides = sides.filter(k => toNum(targetObj[k]) > 0);
  if(sides.length === 0) return;
  for(let i=0;i<level;i++){
    sides = (isEnemy && gameState.enemyHasThirdHand) ? ['left','right','third'].filter(k => toNum(targetObj[k]) > 0) : ['left','right'].filter(k => toNum(targetObj[k]) > 0);
    if(sides.length === 0) break;
    const r = sides[rand(0, sides.length - 1)];
    const cur = toNum(targetObj[r]);
    const newVal = safeDecrease(cur, 1);
    if(isEnemy) gameState.enemy[r] = newVal;
    else gameState.player[r] = newVal;
    const el = isEnemy ? (hands[r === 'left' ? 'enemyLeft' : (r === 'right' ? 'enemyRight' : 'enemyThird')]) : (hands[r === 'left' ? 'playerLeft' : 'playerRight']);
    showPopupText(el, `-${1}`, '#ff9e9e');
  }
}

/* ---------- active handlers (player) ---------- */
function applyPendingActiveOnPlayer(side){
  if(!gameState.pendingActiveUse) return;
  const pending = gameState.pendingActiveUse;
  const sk = gameState.equippedSkills[pending.idx];
  if(!sk || sk.used){ gameState.pendingActiveUse = null; messageArea.textContent = 'そのスキルは使用できません'; return; }

  // HEAL (既存)
  if(pending.id === 'heal'){
    const amount = 1 + sk.level;
    playSE('skill', 0.7);
    const cur = toNum(gameState.player[side]);
    const newVal = safeDecrease(cur, amount);
    gameState.player[side] = newVal;
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (-${amount})`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(el, `-${amount}`, '#ff9e9e');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  // OVERHEAT (新): 自身の手 +3, プレイヤーシールド + level
  if(pending.id === 'overheat'){
    const amount = 3;
    playSE('skill', 0.8);
    const cur = toNum(gameState.player[side]);
    const newVal = Math.min(HARD_CAP, cur + amount);
    gameState.player[side] = newVal;
    // add shield
    gameState.playerShield = (gameState.playerShield || 0) + (sk.level || 1);
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (+${amount}) — シールド +${sk.level}`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(el, `+${amount}`, '#ffd166');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  // PUMP UP (新): 自身の手 + level
  if(pending.id === 'pumpUp'){
    const amount = sk.level || 1;
    playSE('skill', 0.7);
    const cur = toNum(gameState.player[side]);
    const newVal = Math.min(HARD_CAP, cur + amount);
    gameState.player[side] = newVal;
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (+${amount})`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(el, `+${amount}`, '#ffd166');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  // SPLIT (新): 片手のみ生存 && 値 >= 2 の場合に発動
  if(pending.id === 'split'){
    // check alive hands
    const alive = ['left','right'].filter(k => toNum(gameState.player[k]) > 0);
    if(alive.length !== 1){
      messageArea.textContent = '分割は片手のみ生存している時に使用できます';
      gameState.pendingActiveUse = null;
      return;
    }
    if(alive[0] !== side){
      messageArea.textContent = '分割は生存している手を選んでください';
      gameState.pendingActiveUse = null;
      return;
    }
    const val = toNum(gameState.player[side]);
    if(val < 2){
      messageArea.textContent = '分割するには値が2以上必要です';
      gameState.pendingActiveUse = null;
      return;
    }
    playSE('skill', 0.75);
    const half1 = Math.floor(val / 2);
    const half2 = Math.ceil(val / 2);
    const other = side === 'left' ? 'right' : 'left';
    gameState.player[side] = half1;
    gameState.player[other] = half2;
    sk.used = true;
    messageArea.textContent = `${sk.name} を使用：${val} → ${half1} / ${half2}`;
    const elSide = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    const elOther = hands[other === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(elSide, `${half1}`, '#ffd166');
    showPopupText(elOther, `${half2}`, '#ffd166');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  // fallback
  gameState.pendingActiveUse = null;
  messageArea.textContent = 'その操作は無効です';
}

/* ---------- active handlers (player -> enemy) ---------- */
function applyPendingActiveOnEnemy(side){
  if(!gameState.pendingActiveUse) return;
  const pending = gameState.pendingActiveUse;
  const sk = gameState.equippedSkills[pending.idx];
  if(!sk || sk.used){ gameState.pendingActiveUse = null; messageArea.textContent = 'そのスキルは使用できません'; return; }

  if(pending.id === 'disrupt'){
    const amount = 1 + sk.level;
    const key = side;
    const el = hands[key === 'left' ? 'enemyLeft' : (key === 'right' ? 'enemyRight' : 'enemyThird')];
    const cur = toNum(gameState.enemy[key]);
    const newVal = safeDecrease(cur, amount);
    gameState.enemy[key] = newVal;
    showPopupText(el, `-${amount}`, '#ff9e9e');
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${key} に使用しました (-${amount})`;
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
  }
}

/* ---------- player attack ---------- */
function playerAttack(targetSide){
  if(gameState.inBossReward) return;
  if(skillSelectArea && skillSelectArea.children.length > 0){
    messageArea.textContent = 'まず装備を確定してください'; return;
  }
  if(!gameState.playerTurn) return;
  if(!selectedHand){ messageArea.textContent = '攻撃する手を選んでください'; return; }
  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'heal'){ messageArea.textContent = 'ヒール使用中：自分の手を選んでください'; return; }

  const attackerKey = selectedHand;
  const attackerEl = hands[attackerKey === 'left' ? 'playerLeft' : 'playerRight'];
  const targetEl = hands[targetSide === 'left' ? 'enemyLeft' : (targetSide === 'right' ? 'enemyRight' : 'enemyThird')];

  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'disrupt'){
    applyPendingActiveOnEnemy(targetSide);
    return;
  }

  playSE('attack', 0.7);
  animateAttack(attackerEl, targetEl);

  let baseAtk = toNum(gameState.player[attackerKey]);
  baseAtk += computePlayerAttackBonus(attackerKey);

  const defense = computeDefenseForTarget(true);

  let multiplier = gameState.doubleMultiplier || 1;
  gameState.doubleMultiplier = 1;
  if(multiplier > 1){
    const idx = (gameState.equippedSkills || []).findIndex(s => s.id === 'double' && !s.used);
    if(idx !== -1) { gameState.equippedSkills[idx].used = true; renderEquipped(); }
  }

  let rawAdded = baseAtk * multiplier;
  const added = Math.max(0, rawAdded - defense);

  showDamage(targetEl, baseAtk);

  const curEnemy = toNum(gameState.enemy[targetSide]);
  let newVal = curEnemy + added;
  if(!Number.isFinite(newVal)) newVal = 0;

  const destroyThreshold = getDestroyThreshold(true);
  let destroyed = false;

  // 保存しておく（破壊前の attempted value = newVal）
  const attemptedValue = newVal;

  if(Number(newVal) >= Number(destroyThreshold)){
    // 破壊
    newVal = 0;
    destroyed = true;
    animateDestroy(targetEl);
    playSE('destroy', 0.9);

    // 破壊された後にボス能力が onHandDestroyed を持っていれば渡す（転生等）
    if(gameState.isBoss && gameState.bossAbility && typeof gameState.bossAbility.onHandDestroyed === 'function'){
      try { gameState.bossAbility.onHandDestroyed(targetSide, attemptedValue); } catch(e){}
      // onHandDestroyed の中で復活させる場合は上書きされる
    }
  } else {
    if(newVal > HARD_CAP) newVal = HARD_CAP;
  }

  gameState.enemy[targetSide] = newVal;

  handleCounter(false, attackerKey, true, targetSide);

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

  if(gameState.isBoss && gameState.bossAbility && typeof gameState.bossAbility.onPlayerTurnEnd === 'function'){
    try { gameState.bossAbility.onPlayerTurnEnd(); } catch(e){}
    if(gameState.bossTurnCount <= 0) {
      return;
    }
  }

  if(!checkWinLose()) setTimeout(()=> enemyTurn(), 650);
}

/* ---------- enemy turn ---------- */
function enemyTurn(){
  if(gameState.inBossReward) return;

  if(gameState.isBoss && gameState.bossAbility && typeof gameState.bossAbility.onEnemyTurnStart === 'function'){
    try { gameState.bossAbility.onEnemyTurnStart(); } catch(e){}
  }

  const alivePlayer = ['left','right'].filter(s => toNum(gameState.player[s]) > 0);
  const enemyKeys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
  const aliveEnemy = enemyKeys.filter(s => toNum(gameState.enemy[s]) > 0);

  if(alivePlayer.length === 0 || aliveEnemy.length === 0) return;

  (gameState.enemySkills || []).forEach(skill => {
    if(skill.remainingCooldown && skill.remainingCooldown > 0) return;

    if(skill.id === 'heal'){
      const candidates = enemyKeys.filter(k => toNum(gameState.enemy[k]) > 0);
      if(candidates.length > 0 && Math.random() < 0.6){
        const r = candidates[rand(0, candidates.length - 1)];
        const amount = 1 + skill.level;
        const cur = toNum(gameState.enemy[r]);
        const newVal = safeDecrease(cur, amount);
        gameState.enemy[r] = newVal;
        const el = hands[r === 'left' ? 'enemyLeft' : (r === 'right' ? 'enemyRight' : 'enemyThird')];
        showPopupText(el, `-${amount}`, '#ff9e9e');
        skill.remainingCooldown = 2;
        messageArea.textContent = `敵が ${skill.name} を使用した`;
      }
    }

    if(skill.id === 'double'){
      if(Math.random() < 0.35){
        gameState.enemyDoubleMultiplier = 1 + skill.level;
        skill.remainingCooldown = 2;
        messageArea.textContent = `敵が ${skill.name} を構えた`;
      }
    }

    if(skill.id === 'regen'){
      applyRegenToUnit(true, skill.level);
    }

    if(skill.id === 'fortify' && Math.random() < 0.25){
      const duration = 2 * skill.level;
      applyEnemyTurnBuff('fortify', skill.level, duration);
      skill.remainingCooldown = 3;
      messageArea.textContent = `敵が ${skill.name} を構えた`;
    }

    if(skill.id === 'chain' && Math.random() < 0.25){
      applyEnemyTurnBuff('chain', skill.level, 1);
      const tb = gameState.enemyTurnBuffs[gameState.enemyTurnBuffs.length - 1];
      if(tb) tb.payload = { type:'chainBoost', value: skill.level };
      skill.remainingCooldown = 2;
      messageArea.textContent = `敵が ${skill.name} を準備`;
    }

    if(skill.id === 'disrupt' && Math.random() < 0.35){
      const candidates = ['left','right'].filter(k => toNum(gameState.player[k]) > 0);
      if(candidates.length > 0){
        const target = candidates[rand(0, candidates.length-1)];
        const amount = 1 + skill.level;
        const cur = toNum(gameState.player[target]);
        const newVal = safeDecrease(cur, amount);
        gameState.player[target] = newVal;
        const el = hands[target === 'left' ? 'playerLeft' : 'playerRight'];
        showPopupText(el, `-${amount}`, '#ffb86b');
        skill.remainingCooldown = 2;
        messageArea.textContent = `敵が ${skill.name} を使用した`;
      }
    }

    if(skill.id === 'teamPower' && Math.random() < 0.2){
      const duration = 2 * skill.level;
      applyEnemyTurnBuff('teamPower', skill.level, duration);
      skill.remainingCooldown = 3;
      messageArea.textContent = `敵が ${skill.name} を使用（味方全体強化）`;
    }
  });

  updateEnemySkillUI();

  const from = aliveEnemy[rand(0, aliveEnemy.length - 1)];
  const to = alivePlayer[rand(0, alivePlayer.length - 1)];

  const attackerEl = (from === 'left' ? hands.enemyLeft : (from === 'right' ? hands.enemyRight : hands.enemyThird));
  const targetEl = (to === 'left' ? hands.playerLeft : hands.playerRight);

  playSE('attack', 0.65);
  animateAttack(attackerEl, targetEl);

  let attackValue = toNum(gameState.enemy[from]);
  attackValue += computeEnemyAttackBonus(from);

  // base defense: apply player battle defense multiplier
  const baseDef = (gameState.baseStats && gameState.baseStats.baseDefense) ? Number(gameState.baseStats.baseDefense) : 0;
  const playerDefMul = (gameState.playerBattleModifiers && gameState.playerBattleModifiers.defenseMultiplier) ? gameState.playerBattleModifiers.defenseMultiplier : 1;
  const defense = computeDefenseForTarget(false) + (baseDef * playerDefMul);
  attackValue = Math.max(0, attackValue - defense);

  const reduction = computeEnemyAttackReduction();
  attackValue = Math.max(0, attackValue - reduction);

  const multiplier = gameState.enemyDoubleMultiplier || 1;
  gameState.enemyDoubleMultiplier = 1;
  attackValue = attackValue * multiplier;

  gameState.enemyTurnBuffs.forEach(tb => {
    if(tb.payload && tb.payload.type === 'chainBoost') attackValue += tb.payload.value;
    if(tb.payload && tb.payload.type === 'teamPower') attackValue += tb.payload.value;
  });

  // --- SHIELD handling for player (オーバーヒート) ---
  let remainingAttack = attackValue;
  if(gameState.playerShield && gameState.playerShield > 0){
    const absorbed = Math.min(remainingAttack, gameState.playerShield);
    gameState.playerShield -= absorbed;
    remainingAttack = Math.max(0, remainingAttack - absorbed);
    if(absorbed > 0){
      showPopupText(targetEl, `Shield -${absorbed}`, '#ffd166');
    }
  }

  showDamage(targetEl, attackValue, '#ffb86b');

  let curPlayer = toNum(gameState.player[to]);
  let newVal = curPlayer + remainingAttack;
  if(!Number.isFinite(newVal)) newVal = 0;

  const destroyThreshold = getDestroyThreshold(false);

  const wasDestroyed = Number(newVal) >= Number(destroyThreshold);
  if(wasDestroyed){
    newVal = 0;
    animateDestroy(targetEl);
    playSE('destroy', 0.9);
  } else {
    if(newVal > HARD_CAP) newVal = HARD_CAP;
  }

  gameState.player[to] = newVal;

  handleCounter(true, from, false, to);

  (gameState.enemySkills || []).forEach(s => {
    if(s.id === 'revenge'){
      const keys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
      keys.forEach(side => {
        if(toNum(gameState.enemy[side]) === 0){
          const amount = s.level;
          gameState.enemy[side] = Math.min(HARD_CAP, toNum(gameState.enemy[side]) + amount);
          const el = (side === 'left' ? hands.enemyLeft : (side === 'right' ? hands.enemyRight : hands.enemyThird));
          showDamage(el, amount, '#ff9e9e');
          messageArea.textContent = `敵の ${s.name} が発動した！`;
        }
      });
    }
  });

  tickTurnBuffs();
  tickEnemyTurnBuffs();

  gameState.playerTurn = true;
  updateUI();
  flashScreen();
  checkWinLose();
}

/* ---------- pending active wrapper for player heal ---------- */
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
  const enemyKeys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
  const enemyDead = enemyKeys.every(k => toNum(gameState.enemy[k]) === 0);

  if(enemyDead){
    playSE('victory', 0.8);
    if(gameState.isBoss){
      messageArea.textContent = 'Boss Defeated! 基礎ステータスを1つ選択してください';
      setTimeout(()=> showBossRewardSelection(), 350);
      return true;
    } else {
      messageArea.textContent = 'Victory! スキル報酬を獲得';
      setTimeout(()=> showRewardSelection(), 600);
      return true;
    }
  }
  if(playerDead){
    playSE('lose', 0.8);
    messageArea.textContent = 'Game Over';
    if(gameState.stage > gameState.bestStage){
      gameState.bestStage = gameState.stage;
      saveBest();
    }
    setTimeout(()=> {
      if(bestStageValue) bestStageValue.textContent = gameState.bestStage;
      showTitle();
    }, 1000);
    return true;
  }
  return false;
}

/* ---------- weighted selection helpers ---------- */
function getSkillWeight(skill){
  const r = skill.rarity || 'common';
  if(r === 'common') return 60;
  if(r === 'rare') return 30;
  if(r === 'epic') return 10;
  return 50;
}
function weightedRandomSkillFromList(list){
  if(!list || list.length === 0) return null;
  const total = list.reduce((sum,s)=>sum+getSkillWeight(s),0);
  let r = Math.random()*total;
  for(const s of list){
    const w = getSkillWeight(s);
    if(r < w) return s;
    r -= w;
  }
  return list[0];
}

/* ---------- 基礎ステータス報酬 (報酬候補0件時の救済) ---------- */
function generateBaseStatRewards(){
  const pool = [
    {
      id: 'baseAttack',
      name: '⚔ 基礎攻撃 +1',
      desc: '全ての攻撃に恒久的に +1（ラン内有効）',
      apply: () => { gameState.baseStats.baseAttack = (gameState.baseStats.baseAttack || 0) + 1; }
    },
    {
      id: 'baseDefense',
      name: '🛡 基礎防御 +1',
      desc: '敵の攻撃に対する恒久的な防御 +1（ラン内有効）',
      apply: () => { gameState.baseStats.baseDefense = (gameState.baseStats.baseDefense || 0) + 1; }
    },
    {
      id: 'playerThreshold',
      name: '💎 指の最大値 +1',
      desc: '指の最大値を +1（プレイヤー側、ラン内有効）',
      apply: () => { gameState.baseStats.playerThreshold = (Number.isFinite(Number(gameState.baseStats.playerThreshold)) ? gameState.baseStats.playerThreshold : 5) + 1; }
    }
  ];

  return pool.sort(() => Math.random() - 0.5).slice(0, 3);
}

function showBaseRewardSelection(rewards){
  skillSelectArea.innerHTML = '';
  messageArea.textContent = 'スキル報酬がありません。基礎能力を強化してください';

  const wrap = document.createElement('div');
  wrap.className = 'skill-choices';

  rewards.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'skill-btn node-btn';
    btn.innerHTML = `<div style="font-weight:700">${r.name}</div><small style="opacity:.9">${r.desc}</small>`;
    btn.onclick = () => {
      playSE('click', 0.6);
      r.apply();
      messageArea.textContent = `${r.name} を獲得しました`;
      skillSelectArea.innerHTML = '';
      updateUI();
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

/* ---------- reward selection (weighted by rarity) ---------- */
function showRewardSelection(){
  const unlockedIds = (gameState.unlockedSkills || []).map(u=>u.id);
  const notUnlocked = SKILL_POOL.filter(s => !unlockedIds.includes(s.id));
  const picks = [];

  const tempPool = notUnlocked.slice();
  while(picks.length < 3 && tempPool.length > 0){
    const pick = weightedRandomSkillFromList(tempPool);
    if(!pick) break;
    picks.push({ id: pick.id, isNew:true });
    const idx = tempPool.findIndex(x=>x.id===pick.id);
    if(idx!==-1) tempPool.splice(idx,1);
  }

  const getCap = (skillId) => SKILL_LEVEL_CAP[skillId] || MAX_SKILL_LEVEL;

  const upgradeCandidates = (gameState.unlockedSkills || [])
    .filter(u => {
      const cap = getCap(u.id);
      return (u.level || 1) < cap;
    })
    .map(u => ({ id: u.id, level: u.level, isUpgrade:true }));

  while(picks.length < 3 && upgradeCandidates.length > 0){
    const u = upgradeCandidates.shift();
    picks.push({ id: u.id, isUpgrade:true });
  }

  if(picks.length < 3){
    const remainingNotUnlocked = SKILL_POOL.filter(s => !picks.some(p=>p.id===s.id));
    for(const s of remainingNotUnlocked){
      if(picks.length >= 3) break;
      if(!unlockedIds.includes(s.id)) picks.push({ id: s.id, isNew:true });
    }
  }

  if(picks.length === 0){
    const baseRewards = generateBaseStatRewards();
    showBaseRewardSelection(baseRewards);
    return;
  }

  skillSelectArea.innerHTML = '';
  messageArea.textContent = '報酬スキルを1つ選んでください（永久アンロック / アップグレード）';
  const wrap = document.createElement('div'); wrap.className = 'skill-choices';

  picks.forEach(p => {
    const def = SKILL_POOL.find(s=>s.id===p.id);
    if(!def) return;
    const unlockedObj = gameState.unlockedSkills.find(u=>u.id===p.id);
    const label = p.isUpgrade ? `${def.name} を上昇 (現在 Lv${unlockedObj ? unlockedObj.level : 0})` : `${def.name} をアンロック`;
    const btn = document.createElement('button');
    btn.className = 'skill-btn node-btn';
    btn.classList.add('rarity-' + (def.rarity || 'common'));
    btn.innerHTML = `<div style="font-weight:700">${label}</div><small style="opacity:.9">${def.baseDesc}</small><div style="font-size:11px;opacity:.85;margin-top:6px">${(def.rarity||'common').toUpperCase()}</div>`;
    btn.onclick = () => {
      playSE('click', 0.5);
      if(p.isUpgrade && unlockedObj){
        const cap = getCap(def.id);
        unlockedObj.level = Math.min(cap, (unlockedObj.level || 1) + 1);
        messageArea.textContent = `${def.name} を Lv${unlockedObj.level} に強化しました`;
      } else {
        const cap = getCap(def.id);
        if(unlockedObj){
          unlockedObj.level = Math.min(cap, (unlockedObj.level || 1) + 1);
          messageArea.textContent = `${def.name} を Lv${unlockedObj.level} に強化しました`;
        } else {
          gameState.unlockedSkills.push({ id: def.id, level: 1 });
          messageArea.textContent = `${def.name} をアンロックしました！`;
        }
      }
      saveUnlocked();
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

/* ---------- boss reward selection (baseStats +1) ---------- */
function showBossRewardSelection(){
  gameState.inBossReward = true;
  gameState.playerTurn = false;

  skillSelectArea.innerHTML = '';
  messageArea.textContent = 'ボス報酬を1つ選んでください（ラン内で恒久）';

  const wrap = document.createElement('div');
  wrap.className = 'skill-choices';

  const options = [
    { key:'playerThreshold', label:`指の最大値 +1 （現在 ${gameState.baseStats.playerThreshold}）` },
    { key:'baseAttack', label:`基礎攻撃力 +1 （現在 ${gameState.baseStats.baseAttack}）` },
    { key:'baseDefense', label:`基礎防御力 +1 （現在 ${gameState.baseStats.baseDefense}）` }
  ];

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'node-btn current';
    btn.textContent = opt.label;
    btn.onclick = () => {
      playSE('click', 0.6);
      if(opt.key === 'playerThreshold'){
        const cur = Number(gameState.baseStats.playerThreshold);
        gameState.baseStats.playerThreshold = Number.isFinite(cur) ? (cur + 1) : 6;
      } else {
        gameState.baseStats[opt.key] = (gameState.baseStats[opt.key] || 0) + 1;
      }
      messageArea.textContent = `${opt.label} を獲得しました`;
      // boss temporary effects should be cleared now (won't carry over)
      gameState.bossEnemyThresholdMultiplier = 1;
      gameState.bossAbility = null;
      gameState.enemyHasThirdHand = false;
      updateUI();
      gameState.inBossReward = false;
      skillSelectArea.innerHTML = '';
      flashScreen(.18);
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
  if(gameState.inBossReward) return;
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

  // If an active requiring player-hand target is pending, handle here
  if(gameState.pendingActiveUse && ['heal','overheat','pumpUp','split'].includes(gameState.pendingActiveUse.id)){
    applyPendingActiveOnPlayer(side);
    return;
  }

  if(selectedHand === side){
    selectedHand = null;
    if(hands.playerLeft) hands.playerLeft.classList.remove('selected');
    if(hands.playerRight) hands.playerRight.classList.remove('selected');
    messageArea.textContent = '選択を解除しました';
    return;
  }

  selectedHand = side;
  if(hands.playerLeft) hands.playerLeft.classList.toggle('selected', side === 'left');
  if(hands.playerRight) hands.playerRight.classList.toggle('selected', side === 'right');

  messageArea.textContent = '敵の手を選んで攻撃してください';
}
function clickEnemyHand(side){
  if(gameState.inBossReward) return;
  if(skillSelectArea && skillSelectArea.children.length > 0){ messageArea.textContent = 'まず装備を確定してください'; return; }
  if(!gameState.playerTurn) return;

  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'disrupt'){
    applyPendingActiveOnEnemy(side);
    return;
  }

  if(!selectedHand){ messageArea.textContent = '攻撃する手を選んでください'; return; }
  if(toNum(gameState.enemy[side]) === 0){ messageArea.textContent = 'その敵の手は既に0です'; return; }

  playSE('click', 0.5);
  playerAttack(side);
}

if(hands.playerLeft) hands.playerLeft.onclick = () => selectHand('left');
if(hands.playerRight) hands.playerRight.onclick = () => selectHand('right');
if(hands.enemyLeft) hands.enemyLeft.onclick = () => clickEnemyHand('left');
if(hands.enemyRight) hands.enemyRight.onclick = () => clickEnemyHand('right');
if(hands.enemyThird) hands.enemyThird.onclick = () => clickEnemyHand('third');

/* ---------- Hover / Overlay: hand-specific details ---------- */
function setupHoverHandlers(){
  const mapping = [
    { el: hands.enemyLeft, owner: 'enemy', hand: 'left' },
    { el: hands.enemyRight, owner: 'enemy', hand: 'right' },
    { el: hands.enemyThird, owner: 'enemy', hand: 'third' },
    { el: hands.playerLeft, owner: 'player', hand: 'left' },
    { el: hands.playerRight, owner: 'player', hand: 'right' }
  ];

  mapping.forEach(m => {
    if(!m.el) return;
    m.el.onmouseenter = (e) => { showOverlayFor(m.owner, m.hand, e.pageX, e.pageY); };
    m.el.onmousemove = (e) => { moveOverlay(e.pageX, e.pageY); };
    m.el.onmouseleave = () => { removeOverlay(); };
  });
}

function showOverlayFor(owner, hand, x, y){
  removeOverlay();
  _overlayEl = document.createElement('div');
  _overlayEl.className = 'fd-overlay';
  _overlayEl.style.position = 'absolute';
  _overlayEl.style.pointerEvents = 'none';
  _overlayEl.style.zIndex = 1200;
  _overlayEl.style.background = 'rgba(12,12,12,0.92)';
  _overlayEl.style.color = '#fff';
  _overlayEl.style.padding = '10px 12px';
  _overlayEl.style.borderRadius = '10px';
  _overlayEl.style.boxShadow = '0 8px 22px rgba(0,0,0,0.6)';
  _overlayEl.style.fontSize = '13px';
  _overlayEl.dataset.owner = owner;
  _overlayEl.dataset.hand = hand;

  document.body.appendChild(_overlayEl);
  refreshOverlayContent(owner, hand);
  moveOverlay(x, y);
}

function refreshOverlayContent(owner, hand){
  if(!_overlayEl) return;
  _overlayEl.dataset.owner = owner;
  _overlayEl.dataset.hand = hand;

  const isEnemy = (owner === 'enemy');
  const value = isEnemy ? toNum(gameState.enemy[hand]) : toNum(gameState.player[hand]);
  const attackerIsPlayer = isEnemy ? true : false; // hovering enemy => likely player will attack
  const destroyThreshold = getDestroyThreshold(attackerIsPlayer);

  const remaining = Number.isFinite(destroyThreshold) ? (destroyThreshold - value) : '—';
  const remText = (value === 0) ? '破壊済み (0)' : (remaining <= 0 ? '次の標準攻撃で破壊可能' : `破壊まであと ${remaining}`);

  let pierceInfo = '';
  if(attackerIsPlayer){
    const pierceLv = getEquippedLevel('pierce') || 0;
    if(pierceLv > 0) pierceInfo = `（プレイヤーのピアス: Lv${pierceLv} が適用）`;
  } else {
    const enemyPierce = (gameState.enemySkills || []).filter(s=>s.id==='pierce').reduce((sum,s)=>sum+(s.level||0),0);
    if(enemyPierce > 0) pierceInfo = `（敵のピアス: Lv${enemyPierce} が適用）`;
  }

  const buffs = [];
  if(isEnemy){
    (gameState.enemyTurnBuffs || []).forEach(tb => {
      if(tb.payload && tb.remainingTurns>0){
        if(tb.payload.type === 'enemyGuardBoost' || tb.payload.type === 'guardBoost') buffs.push(`防御+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'chainBoost') buffs.push(`次攻撃+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'teamPower') buffs.push(`味方全体+${tb.payload.value} (${tb.remainingTurns}ターン)`);
      }
    });
  } else {
    (gameState.turnBuffs || []).forEach(tb => {
      if(tb.payload && tb.remainingTurns>0){
        if(tb.payload.type === 'guardBoost') buffs.push(`防御+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'chainBoost') buffs.push(`次攻撃+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'teamPower') buffs.push(`味方全体+${tb.payload.value} (${tb.remainingTurns}ターン)`);
      }
    });
  }

  let attackerDouble = (attackerIsPlayer ? gameState.doubleMultiplier : gameState.enemyDoubleMultiplier) || 1;
  const attackerDoubleText = attackerDouble > 1 ? `（次の攻撃が×${attackerDouble}）` : '';

  let sampleAtt = 0;
  if(attackerIsPlayer){
    sampleAtt = Math.max(toNum(gameState.player.left), toNum(gameState.player.right)) + computePlayerAttackBonus('left');
  } else {
    const keys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
    const bestKey = keys.reduce((a,b) => (toNum(gameState.enemy[a]) > toNum(gameState.enemy[b]) ? a : b));
    sampleAtt = Math.max(toNum(gameState.enemy[bestKey]), 0) + computeEnemyAttackBonus(bestKey);
  }
  const sampleText = `代表攻撃力目安: ${sampleAtt} ${attackerDoubleText}`;

  let html = `<div style="font-weight:800; margin-bottom:6px">${isEnemy ? '敵' : 'あなた'} — ${hand === 'left' ? '左手' : (hand === 'right' ? '右手' : '第3の手')}</div>`;
  html += `<div>現在値: <b>${value}</b></div>`;
  html += `<div>最大値（想定攻撃元に対して）: <b>${destroyThreshold}</b> ${pierceInfo}</div>`;
  html += `<div style="margin-top:6px; font-weight:700">${remText}</div>`;
  html += `<div style="margin-top:6px; color:#ccc">${sampleText}</div>`;
  if(buffs.length > 0){
    html += `<div style="margin-top:8px; color:#ffd">${buffs.join(' / ')}</div>`;
  }

  const skills = isEnemy ? (gameState.enemySkills || []) : (gameState.equippedSkills || []).filter(s=>s.type==='passive' || s.type==='event' || s.type==='combo');
  if(skills && skills.length > 0){
    const skillNames = skills.map(s => `${s.name} Lv${s.level||1}`);
    html += `<div style="margin-top:8px; font-size:12px; opacity:0.9">関連スキル: ${skillNames.join(' / ')}</div>`;
  }

  _overlayEl.innerHTML = html;
}

function moveOverlay(x, y){
  if(!_overlayEl) return;
  const offset = 12;
  _overlayEl.style.left = (x + offset) + 'px';
  _overlayEl.style.top = (y + offset) + 'px';
}

function removeOverlay(){
  if(_overlayEl){
    _overlayEl.remove();
    _overlayEl = null;
  }
}

/* ---------- boss helpers ---------- */
function assignBossAbility(){
  const ability = BOSS_ABILITIES[rand(0, BOSS_ABILITIES.length - 1)];
  gameState.bossAbility = ability;
  if(ability && typeof ability.apply === 'function'){
    ability.apply();
  }
  if(gameState.enemyHasThirdHand && typeof gameState.enemy.third === 'undefined') gameState.enemy.third = 1;
  updateUI();
}

/* ---------- force lose (タイムリミット) ---------- */
function forceLose(){
  messageArea.textContent = 'タイムアップ…強制敗北！';
  playSE('lose', 0.9);
  setTimeout(()=> {
    showTitle();
  }, 1400);
}

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
  assignEnemySkills,
  showBossRewardSelection,
  assignBossAbility,
  debug_getDestroyThreshold: getDestroyThreshold
};
