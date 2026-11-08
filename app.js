// Tilt 360 Viewer（公開版）
// 360°回転する動画を選ぶと、全フレームを取り出して、スマホの傾きに合わせて表示する。
// 動画は端末の中だけで処理する（ファイル → blob: URL → canvas）。外部への送信は CSP でも禁止している。
// 継ぎ目の処理や回転の向きは、動画を書き出すときに済ませておく前提（全フレームをそのまま1周として使う）。
'use strict';
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const msg = t => document.getElementById('msg').textContent = t;
const warn = t => document.getElementById('warn').textContent = t;
const cancelBtn = document.getElementById('cancel');
const sens = document.getElementById('sens');
const FPS = 24;
let frames = [], pos = 0, target = 0, shown = 0, reversed = false;
let R0 = null, Rnow = null, tilt = 0, tiltF = null, hasSensor = false;

sens.oninput = () => document.getElementById('sensv').textContent = (+sens.value).toFixed(1);
document.getElementById('hide').onclick = () => document.getElementById('ui').classList.toggle('hidden');

// ---- 動画 → フレーム配列 ----
// 読み込み中は前の動画を表示したままにし、終わったら差し替える。
// キャンセル、または読み込み中に別の動画を選んだら、そこで止める（loadId が変わったら中断）
let loadId = 0;
document.getElementById('file').onchange = e => {
  const f = e.target.files[0];
  e.target.value = ''; // 同じ動画をもう一度選べるように
  if (f) loadVideo(f).catch(err => { if (err.message !== 'cancel') msg('読み込み失敗: ' + err.message); });
};
cancelBtn.onclick = () => { loadId++; cancelBtn.classList.add('off'); };
async function loadVideo(file) {
  const id = ++loadId, url = URL.createObjectURL(file), got = [];
  const check = () => { if (id !== loadId) throw new Error('cancel'); };
  cancelBtn.classList.remove('off'); warn(''); msg('動画を読み込み中…');
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('この動画は読めません')); });
    check();
    const dur = v.duration, total = Math.max(2, Math.round(dur * FPS));
    const scale = Math.min(1, 900 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    for (let i = 0; i < total; i++) {
      // フレーム i の表示区間の中央へシーク（境界だと前後のフレームになることがある）
      v.currentTime = Math.min(dur - 0.001, (i + 0.5) / FPS);
      await new Promise(r => v.onseeked = r);
      check();
      tc.drawImage(v, 0, 0, w, h);
      got.push(await createImageBitmap(tmp));
      msg(`フレーム取り出し中… ${i + 1}/${total}（キャンセルできます）`);
    }
    check();
    frames.forEach(b => b.close && b.close());
    frames = reversed ? reverseOrder(got) : got;
    cv.width = w; cv.height = h; pos = target = shown = 0; R0 = null; tiltF = null;
    warn(loopWarning(got));
    msg(hasSensor ? '左右に傾けると回ります' : '画面をタップすると傾きセンサーが有効になります（PC ではドラッグ）');
  } catch (err) {
    got.forEach(b => b.close && b.close());
    if (err.message === 'cancel') msg(frames.length ? 'キャンセルしました（前の動画を表示中）' : 'キャンセルしました');
    throw err;
  } finally {
    URL.revokeObjectURL(url);
    if (id === loadId) cancelBtn.classList.add('off');
  }
}

// ---- 360°の1周動画かどうかの簡易チェック（警告だけ。表示はする） ----
// 小さく縮めた輝度で PSNR を測り、「最後 → 最初」の変化を普段の1コマの変化と比べる（scripts/check_loop.py と同じ考え方）
function lumaSmall(bmp) {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, 96, 96);
  const d = x.getImageData(0, 0, 96, 96).data, g = new Float32Array(96 * 96);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}
function psnr(a, b) {
  let m = 0; for (let i = 0; i < a.length; i++) { const e = a[i] - b[i]; m += e * e; }
  m /= a.length; return m === 0 ? 99 : 10 * Math.log10(255 * 255 / m);
}
function loopWarning(f) {
  const n = f.length; if (n < 8) return '';
  const g = f.map(lumaSmall), adj = [];
  for (let i = 0; i < n - 1; i++) adj.push(psnr(g[i], g[i + 1]));
  adj.sort((a, b) => a - b);
  const med = adj[adj.length >> 1], seam = psnr(g[n - 1], g[0]), mid = psnr(g[0], g[n >> 1]);
  if (mid > 30 && med > 30) return '注意: ほとんど回っていない動画のようです（360°回転する動画用のビューアです）';
  if (seam < med - 4) return '注意: 最後と最初がつながっていません。360°の1周動画ではないかもしれません（正面を通るときに絵が飛びます）';
  return '';
}

// ---- 回転方向（フレーム0＝正面はそのままに、残りを逆順） ----
const reverseOrder = f => f.length > 1 ? [f[0], ...f.slice(1).reverse()] : f;
document.getElementById('dir').onclick = () => {
  reversed = !reversed;
  document.getElementById('dir').textContent = '回転方向: ' + (reversed ? '反転' : '通常');
  if (frames.length) { frames = reverseOrder(frames); pos = -pos; target = -target; shown = -shown; }
};

// ---- 傾きセンサー ----
// 左右の傾き（度）: 「正面」に決めたときの端末の向き R0 から、画面の縦軸のまわりに何度回したか。
// alpha/beta/gamma から向きを丸ごと求めるので、立てて持っても寝かせて持っても同じように動く
function rotMatrix(al, be, ga) { // R = Rz(α)·Rx(β)·Ry(γ)（端末座標 → 地面座標）
  const r = Math.PI / 180, ca = Math.cos(al * r), sa = Math.sin(al * r), cb = Math.cos(be * r), sb = Math.sin(be * r),
    cg = Math.cos(ga * r), sg = Math.sin(ga * r);
  return [[ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
          [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
          [-cb * sg, sb, cb * cg]];
}
function relTilt(R0, R) {
  const a = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * Math.PI / 180;
  const s = [Math.cos(a), -Math.sin(a), 0];                       // 画面の横軸（端末座標）
  const w = [0, 1, 2].map(i => R[i][0] * s[0] + R[i][1] * s[1]); // 地面座標へ
  const v = [0, 1, 2].map(j => R0[0][j] * w[0] + R0[1][j] * w[1] + R0[2][j] * w[2]); // 正面時の端末座標へ
  return Math.atan2(-v[2], v[0] * s[0] + v[1] * s[1]) * 180 / Math.PI;
}
function onOrient(ev) {
  if (ev.gamma == null || ev.beta == null) return;
  if (!hasSensor && frames.length) msg('左右に傾けると回ります');
  hasSensor = true; Rnow = rotMatrix(ev.alpha || 0, ev.beta, ev.gamma);
  if (!R0) R0 = Rnow;
  tilt = relTilt(R0, Rnow);
}
// Android Chrome は画面に触れるまで値が来ないことがあり、iOS はタップで許可が必要。
// 開いたら登録を試み、タップのたびに（まだ値が来ていなければ）登録し直す
const needPerm = typeof DeviceOrientationEvent !== 'undefined' && !!DeviceOrientationEvent.requestPermission;
async function startSensor() {
  try {
    if (needPerm && await DeviceOrientationEvent.requestPermission() !== 'granted') { msg('傾きセンサーが許可されませんでした'); return; }
    removeEventListener('deviceorientation', onOrient);
    addEventListener('deviceorientation', onOrient);
  } catch (err) { /* iOS: タップ以外からの許可要求は失敗する。次のタップで再試行 */ }
}
if (!needPerm) startSensor();
addEventListener('click', () => { if (!hasSensor) startSensor(); });
document.getElementById('calib').onclick = () => { if (Rnow) { R0 = Rnow; tilt = 0; tiltF = 0; } };

// ---- ドラッグ（PC・センサーなし用） ----
let drag = null;
cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, t: target }; });
addEventListener('pointermove', e => { if (drag && frames.length) target = drag.t - (e.clientX - drag.x) / innerWidth * frames.length * sens.value; });
addEventListener('pointerup', () => drag = null);

// ---- 描画ループ ----
let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  const N = frames.length;
  if (N) {
    if (hasSensor && !drag) {
      tiltF = tiltF === null ? tilt : tiltF + (tilt - tiltF) * Math.min(1, dt / 0.08); // 細かい揺れをならす
      target = tiltF / 45 * (N / 4) * sens.value; // 傾き ±45° で ±1/4 周 ×感度
    }
    pos += (target - pos) * Math.min(1, dt * 10);
    if (Math.abs(pos - shown) > 0.65) shown = Math.round(pos); // 2コマの境目でちらつかないように
    ctx.drawImage(frames[((shown % N) + N) % N], 0, 0);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---- オフライン（一度開けば電波がなくても使える） ----
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
