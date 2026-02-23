const gameState = {
  stage: 1,
  isBoss: false,
  player: { left: 1, right: 1 },
  enemy: { left: 1, right: 1 },
  playerTurn: true
};

let selectedHand = null;

const stageInfo = document.getElementById("stageInfo");
const turnInfo = document.getElementById("turnInfo");
const messageDiv = document.getElementById("message");

const playerGauge = document.getElementById("playerGauge");
const enemyGauge = document.getElementById("enemyGauge");

const flashLayer = document.getElementById("flashLayer");

const hands = {
  playerLeft: document.getElementById("player-left"),
  playerRight: document.getElementById("player-right"),
  enemyLeft: document.getElementById("enemy-left"),
  enemyRight: document.getElementById("enemy-right")
};

const rand = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function initGame() {
  startBattle();
}

function startBattle() {
  selectedHand = null;
  gameState.playerTurn = true;

  gameState.isBoss = gameState.stage % 3 === 0;
  document.body.classList.toggle("boss", gameState.isBoss);

  const base = Math.min(4, 1 + Math.floor(gameState.stage / 2));
  const min = gameState.isBoss ? base : 1;
  const max = gameState.isBoss ? base + 1 : base;

  gameState.enemy.left = rand(min, max);
  gameState.enemy.right = rand(min, max);

  updateUI();
}

function updateUI() {
  stageInfo.textContent =
    `Stage ${gameState.stage} ${gameState.isBoss ? "BOSS" : ""}`;
  turnInfo.textContent =
    gameState.playerTurn ? "Your Turn" : "Enemy Turn";

  updateHand(hands.playerLeft, gameState.player.left);
  updateHand(hands.playerRight, gameState.player.right);
  updateHand(hands.enemyLeft, gameState.enemy.left);
  updateHand(hands.enemyRight, gameState.enemy.right);

  updateGauge();
}

function updateHand(el, value) {
  el.textContent = value;
  el.classList.toggle("zero", value === 0);
}

function updateGauge() {
  const p = gameState.player.left + gameState.player.right;
  const e = gameState.enemy.left + gameState.enemy.right;

  playerGauge.style.width = (p / 8) * 100 + "%";
  enemyGauge.style.width = (e / 8) * 100 + "%";
}

function flashScreen() {
  flashLayer.classList.add("flash");
  setTimeout(() => flashLayer.classList.remove("flash"), 200);
}

function showDamage(target, value) {
  const d = document.createElement("div");
  d.className = "damage";
  d.textContent = "+" + value;
  target.appendChild(d);
  setTimeout(() => d.remove(), 800);
}

function playerAttack(targetSide) {
  if (!gameState.playerTurn || !selectedHand) return;

  const attacker =
    hands[selectedHand === "left" ? "playerLeft" : "playerRight"];
  const target =
    hands[targetSide === "left" ? "enemyLeft" : "enemyRight"];

  animateAttack(attacker, target);

  let value =
    gameState.enemy[targetSide] +
    gameState.player[selectedHand];

  showDamage(target, gameState.player[selectedHand]);

  if (value >= 5) {
    value = 0;
    animateDestroy(target);
  }

  gameState.enemy[targetSide] = value;
  selectedHand = null;
  gameState.playerTurn = false;

  updateUI();
  flashScreen();

  if (!checkWinLose()) {
    setTimeout(enemyTurn, 600);
  }
}

function enemyTurn() {
  const playerSides = ["left", "right"].filter(
    s => gameState.player[s] > 0
  );
  const enemySides = ["left", "right"].filter(
    s => gameState.enemy[s] > 0
  );

  if (!playerSides.length || !enemySides.length) return;

  const from = enemySides[rand(0, enemySides.length - 1)];
  const to = playerSides[rand(0, playerSides.length - 1)];

  const attacker =
    hands[from === "left" ? "enemyLeft" : "enemyRight"];
  const target =
    hands[to === "left" ? "playerLeft" : "playerRight"];

  animateAttack(attacker, target);

  let value =
    gameState.player[to] +
    gameState.enemy[from];

  showDamage(target, gameState.enemy[from]);

  if (value >= 5) {
    value = 0;
    animateDestroy(target);
  }

  gameState.player[to] = value;
  gameState.playerTurn = true;

  updateUI();
  flashScreen();
  checkWinLose();
}

function animateAttack(attacker, target) {
  attacker.classList.add("attack");
  target.classList.add("hit");
  setTimeout(() => {
    attacker.classList.remove("attack");
    target.classList.remove("hit");
  }, 300);
}

function animateDestroy(target) {
  target.classList.add("destroy");
  setTimeout(() => {
    target.classList.remove("destroy");
  }, 400);
}

function checkWinLose() {
  const playerDead =
    gameState.player.left === 0 &&
    gameState.player.right === 0;

  const enemyDead =
    gameState.enemy.left === 0 &&
    gameState.enemy.right === 0;

  if (enemyDead) {
    messageDiv.textContent = "Victory!";
    gameState.stage++;
    setTimeout(startBattle, 1200);
    return true;
  }

  if (playerDead) {
    messageDiv.textContent = "Game Over";
    return true;
  }

  return false;
}

function selectHand(side) {
  if (!gameState.playerTurn) return;
  if (gameState.player[side] === 0) return;

  selectedHand = side;

  hands.playerLeft.classList.remove("selected");
  hands.playerRight.classList.remove("selected");

  hands[side === "left" ? "playerLeft" : "playerRight"]
    .classList.add("selected");
}

hands.playerLeft.onclick = () => selectHand("left");
hands.playerRight.onclick = () => selectHand("right");
hands.enemyLeft.onclick = () => playerAttack("left");
hands.enemyRight.onclick = () => playerAttack("right");

initGame();
