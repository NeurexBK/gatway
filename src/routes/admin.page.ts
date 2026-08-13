/**
 * Painel do admin — página única, embutida como string.
 *
 * Embutir em vez de servir um arquivo estático é deliberado: `tsc` não copia
 * assets para `dist/`, e um passo extra de build só para um HTML seria mais
 * frágil do que isto. Sem CDN, sem framework — tudo inline.
 *
 * A página não contém segredo nenhum: pede a ADMIN_API_KEY, guarda em
 * sessionStorage (morre ao fechar a aba) e chama /admin/api/*.
 */
export const ADMIN_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gateway — Admin</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:600}
  main{padding:20px;max-width:1180px;margin:0 auto;display:grid;gap:16px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
  .kpi{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px}
  .kpi b{display:block;font-size:20px;font-weight:600;margin-top:4px}
  .kpi span{color:var(--dim);font-size:12px}
  label{display:block;font-size:12px;color:var(--dim);margin:8px 0 4px}
  input,select,button{font:inherit;color:var(--tx);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px}
  input:focus,select:focus{outline:1px solid var(--acc)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;font-weight:600}
  button.ghost{background:var(--panel2);border-color:var(--line);color:var(--tx);font-weight:500}
  button.danger{background:var(--warn);border-color:var(--warn)}
  button:disabled{opacity:.5;cursor:not-allowed}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--dim);font-weight:500;font-size:12px}
  .row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}.dim{color:var(--dim)}
  .banner{padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:13px;border:1px solid}
  .banner.w{background:#3a2c12;border-color:#6b4f1c;color:#ffd899}
  .banner.e{background:#3a1a1a;border-color:#6b2a2a;color:#ffc4c4}
  .scroll{overflow-x:auto}
  #gate{position:fixed;inset:0;background:var(--bg);display:grid;place-items:center;z-index:9}
  #gate div{background:var(--panel);border:1px solid var(--line);padding:24px;border-radius:12px;width:min(380px,92vw)}
  .hide{display:none!important}
  td.del{width:1%}
</style>
</head>
<body>
<div id="gate"><div>
  <h1 style="margin-bottom:12px">Gateway — Admin</h1>
  <label>ADMIN_API_KEY</label>
  <!-- type=text de propósito: é um painel local, e um campo password invisível
       + autofill do navegador torna "chave errada" impossível de diagnosticar.
       name aleatório e autocomplete=off desencorajam o autopreenchimento. -->
  <input id="key" type="text" style="width:100%" class="mono" name="gw-admin-key-nofill"
         autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
         placeholder="admindev_…">
  <p class="dim" style="font-size:11px;margin:6px 0 0">Cole a linha inteira do .env se preferir — o prefixo <span class="mono">ADMIN_API_KEY=</span> é removido automaticamente.</p>
  <p id="gateErr" class="err hide" style="font-size:12px"></p>
  <button id="enter" style="width:100%;margin-top:12px">Entrar</button>
</div></div>

<header>
  <h1>Gateway — Admin</h1>
  <span id="envTag" class="dim mono"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="refresh">Atualizar</button>
  <button class="ghost" id="logout">Sair</button>
</header>

<main>
  <div id="warnings"></div>

  <section>
    <h2>Visão geral</h2>
    <div class="grid" id="kpis"></div>
  </section>

  <section>
    <h2>Horário da distribuição de lucro</h2>
    <div class="row">
      <div><label>Ativa</label><select id="sEnabled"><option value="true">sim</option><option value="false">não</option></select></div>
      <div><label>Hora</label><input id="sHour" type="number" min="0" max="23" style="width:80px"></div>
      <div><label>Minuto</label><input id="sMin" type="number" min="0" max="59" style="width:80px"></div>
      <div><label>Timezone (IANA)</label><input id="sTz" style="width:200px" placeholder="Europe/Lisbon"></div>
      <div><label>Lucro mínimo (SOL)</label><input id="sMinProfit" type="number" step="0.001" min="0" style="width:130px"></div>
      <button id="saveSchedule">Salvar</button>
    </div>
    <p class="dim" style="font-size:12px;margin-bottom:0">Próxima execução: <span id="nextRun" class="mono">—</span></p>
  </section>

  <section>
    <h2>Taxa cobrada ao cliente</h2>
    <div class="row">
      <div><label>Margem (bps)</label><input id="fMargin" type="number" min="0" max="10000" style="width:110px"></div>
      <div><label>Piso (bps)</label><input id="fMin" type="number" min="0" max="10000" style="width:110px"></div>
      <div><label>Teto (bps)</label><input id="fMax" type="number" min="0" max="10000" style="width:110px"></div>
      <div><label>Custo fallback (bps)</label><input id="fFallback" type="number" min="0" max="10000" style="width:130px"></div>
      <button id="saveFees">Salvar</button>
    </div>
    <p class="dim" style="font-size:12px">100 bps = 1%. Taxa efetiva = custo do melhor provedor + margem, limitada por piso/teto.</p>
  </section>

  <section>
    <h2>Carteiras do split (lucro)</h2>
    <div class="scroll">
      <table id="recTable">
        <thead><tr><th>Label</th><th>Endereço</th><th>bps</th><th>%</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="ghost" id="addRec">+ carteira</button>
      <span id="bpsSum" class="mono dim"></span>
      <span style="flex:1"></span>
      <button id="saveRecs">Salvar split</button>
    </div>
  </section>

  <section>
    <h2>Taxas dos on-ramps em tempo real</h2>
    <div class="row">
      <div><label>Moeda</label><select id="qCur"><option>EUR</option><option>USD</option><option>BRL</option></select></div>
      <div><label>Valor</label><input id="qAmt" type="number" value="100" min="1" style="width:120px"></div>
      <button class="ghost" id="qGo">Consultar</button>
    </div>
    <div id="feeOut" style="margin-top:12px"></div>
  </section>

  <section>
    <h2>Execuções de distribuição</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="danger" id="runNow">Distribuir agora</button>
      <label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="ignoreMin" style="width:auto"> ignorar mínimo</label>
    </div>
    <div class="scroll"><table id="runTable"><thead><tr><th>Quando</th><th>Trigger</th><th>Status</th><th>SOL</th><th>Ordens</th><th>Detalhe</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Ordens recentes</h2>
    <div class="scroll"><table id="ordTable"><thead><tr><th>Criada</th><th>Status</th><th>Fiat</th><th>Taxa</th><th>Cliente (SOL)</th><th>Lucro (SOL)</th><th>Erro</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let KEY = sessionStorage.getItem('adminKey') || '';

async function api(path, options = {}) {
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY, ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
  return data;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function short(s) { return !s ? '—' : (s.length > 16 ? s.slice(0, 7) + '…' + s.slice(-5) : s); }
function fmt(n, d = 4) { return n == null ? '—' : Number(n).toFixed(d); }

// ── Gate ──
/** Aceita a chave crua, a linha inteira do .env, ou com aspas em volta. */
function normalizeKey(raw) {
  let v = String(raw || '').trim();
  v = v.replace(/^ADMIN_API_KEY\s*=\s*/i, '');
  v = v.replace(/^["']|["']$/g, '');
  return v.trim();
}

$('enter').onclick = async () => {
  KEY = normalizeKey($('key').value);
  if (!KEY) {
    $('gateErr').textContent = 'campo vazio';
    $('gateErr').classList.remove('hide');
    return;
  }
  try {
    await api('/overview');
    sessionStorage.setItem('adminKey', KEY);
    $('gate').classList.add('hide');
    loadAll();
  } catch (e) {
    $('gateErr').textContent = e.message;
    $('gateErr').classList.remove('hide');
  }
};
$('key').onkeydown = (e) => { if (e.key === 'Enter') $('enter').click(); };
$('logout').onclick = () => { sessionStorage.removeItem('adminKey'); location.reload(); };
$('refresh').onclick = () => loadAll();

// ── Overview ──
async function loadOverview() {
  const d = await api('/overview');
  $('envTag').textContent = d.env + ' · vault ' + short(d.vault.address);
  $('kpis').innerHTML = [
    ['Lucro acumulado', fmt(d.profit.accruedSol) + ' SOL', d.profit.orderCount + ' ordens'],
    ['Saldo do vault', d.vault.sol == null ? 'RPC off' : fmt(d.vault.sol) + ' SOL', 'reserva ' + fmt(d.vault.feeReserveSol, 3)],
    ['Próxima distribuição', d.schedule.enabled ? new Date(d.schedule.nextRunAt).toLocaleString() : 'desativada', d.schedule.localTime + ' ' + d.schedule.timezone],
    ['Liquidadas', d.orders.SETTLED, 'aguardando distribuição'],
    ['Distribuídas', d.orders.DISTRIBUTED, 'finalizadas'],
    ['Falhadas', d.orders.FAILED, d.orders.PENDING + ' pendentes'],
  ].map(([k, v, s]) => '<div class="kpi"><span>' + esc(k) + '</span><b>' + esc(v) + '</b><span>' + esc(s) + '</span></div>').join('');

  const w = [];
  if (d.warnings.partialRuns) w.push(['e', 'Existe execução PARCIAL de distribuição. Parte das transferências saiu. NÃO redistribua manualmente — inspecione as assinaturas antes.']);
  if (d.warnings.vaultBelowReserve) w.push(['w', 'Saldo do vault abaixo da reserva de fee: transações podem falhar.']);
  $('warnings').innerHTML = w.map(([c, t]) => '<div class="banner ' + c + '">' + esc(t) + '</div>').join('');
}

// ── Settings ──
async function loadSettings() {
  const s = await api('/settings');
  $('sEnabled').value = String(s.distributionEnabled);
  $('sHour').value = s.distributionHour;
  $('sMin').value = s.distributionMinute;
  $('sTz').value = s.distributionTimezone;
  $('sMinProfit').value = (Number(s.minProfitLamports) / 1e9).toString();
  $('fMargin').value = s.marginBps;
  $('fMin').value = s.minFeeBps;
  $('fMax').value = s.maxFeeBps;
  $('fFallback').value = s.fallbackProviderCostBps;
  $('nextRun').textContent = new Date(s.nextRunAt).toLocaleString();
}

async function save(patch, btn) {
  btn.disabled = true;
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(patch) }); await loadSettings(); await loadOverview(); }
  catch (e) { alert('Erro: ' + e.message); }
  finally { btn.disabled = false; }
}
$('saveSchedule').onclick = (e) => save({
  distributionEnabled: $('sEnabled').value === 'true',
  distributionHour: Number($('sHour').value),
  distributionMinute: Number($('sMin').value),
  distributionTimezone: $('sTz').value.trim(),
  minProfitLamports: String(Math.round(Number($('sMinProfit').value) * 1e9)),
}, e.target);
$('saveFees').onclick = (e) => save({
  marginBps: Number($('fMargin').value),
  minFeeBps: Number($('fMin').value),
  maxFeeBps: Number($('fMax').value),
  fallbackProviderCostBps: Number($('fFallback').value),
}, e.target);

// ── Recipients ──
function recRow(r = { label: '', address: '', bps: 0 }) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><input class="rl" value="' + esc(r.label) + '" style="width:130px"></td>' +
    '<td><input class="ra mono" value="' + esc(r.address) + '" style="width:340px"></td>' +
    '<td><input class="rb" type="number" min="1" max="10000" value="' + esc(r.bps) + '" style="width:90px"></td>' +
    '<td class="rp dim mono">' + (r.bps / 100).toFixed(2) + '%</td>' +
    '<td class="del"><button class="ghost">×</button></td>';
  tr.querySelector('.rb').oninput = sumBps;
  tr.querySelector('button').onclick = () => { tr.remove(); sumBps(); };
  return tr;
}
function sumBps() {
  const rows = [...document.querySelectorAll('#recTable tbody tr')];
  let sum = 0;
  rows.forEach((tr) => {
    const bps = Number(tr.querySelector('.rb').value) || 0;
    sum += bps;
    tr.querySelector('.rp').textContent = (bps / 100).toFixed(2) + '%';
  });
  $('bpsSum').textContent = 'soma: ' + sum + ' bps (' + (sum / 100).toFixed(2) + '%)';
  $('bpsSum').className = 'mono ' + (sum === 10000 ? 'ok' : 'err');
  $('saveRecs').disabled = sum !== 10000;
}
async function loadRecipients() {
  const d = await api('/recipients');
  const tb = document.querySelector('#recTable tbody');
  tb.innerHTML = '';
  d.recipients.forEach((r) => tb.appendChild(recRow(r)));
  sumBps();
}
$('addRec').onclick = () => { document.querySelector('#recTable tbody').appendChild(recRow()); sumBps(); };
$('saveRecs').onclick = async (e) => {
  const recipients = [...document.querySelectorAll('#recTable tbody tr')].map((tr) => ({
    label: tr.querySelector('.rl').value.trim(),
    address: tr.querySelector('.ra').value.trim(),
    bps: Number(tr.querySelector('.rb').value),
  }));
  e.target.disabled = true;
  try { await api('/recipients', { method: 'PUT', body: JSON.stringify({ recipients }) }); await loadRecipients(); alert('Split salvo.'); }
  catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Fees ──
$('qGo').onclick = async () => {
  $('feeOut').innerHTML = '<span class="dim">consultando…</span>';
  try {
    const d = await api('/fees?refresh=1&currency=' + $('qCur').value + '&amount=' + $('qAmt').value);
    const f = d.effectiveFee;
    const rows = d.comparison.quotes.map((q) => '<tr><td>' + esc(q.provider) + '</td><td>' +
      (q.available ? '<span class="ok">' + q.costBps + ' bps</span>' : '<span class="dim">indisponível</span>') +
      '</td><td class="dim">' + esc(q.error || (q.provider === (d.comparison.best && d.comparison.best.provider) ? 'MELHOR' : '')) + '</td></tr>').join('');
    const adapters = d.adapters.map((a) => esc(a.provider) + ': ' + (a.enabled ? 'on' : 'off') + (a.implemented ? '' : ' (não implementado)')).join(' · ');
    $('feeOut').innerHTML =
      '<div class="banner w">' + esc(d.note) + '</div>' +
      '<div class="grid"><div class="kpi"><span>Custo do provedor</span><b>' + f.providerCostBps + ' bps</b><span>' + esc(f.sourceProvider) + '</span></div>' +
      '<div class="kpi"><span>Margem</span><b>' + f.marginBps + ' bps</b><span>configurada</span></div>' +
      '<div class="kpi"><span>Taxa ao cliente</span><b>' + f.feeBps + ' bps</b><span>' + (f.feeBps / 100).toFixed(2) + '%' + (f.clamped ? ' (limitada)' : '') + '</span></div></div>' +
      '<table style="margin-top:12px"><thead><tr><th>Provedor</th><th>Custo</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="dim" style="font-size:12px">Adapters: ' + adapters + '</p>';
  } catch (e) { $('feeOut').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
};

// ── Runs ──
async function loadRuns() {
  const d = await api('/runs');
  document.querySelector('#runTable tbody').innerHTML = d.runs.map((r) => {
    const cls = r.status === 'COMPLETED' ? 'ok' : (r.status === 'SKIPPED' ? 'dim' : (r.status === 'PARTIAL' ? 'err' : 'warn'));
    return '<tr><td class="mono">' + new Date(r.createdAt).toLocaleString() + '</td><td class="dim">' + esc(r.trigger) +
      '</td><td class="' + cls + '">' + esc(r.status) + '</td><td class="mono">' + fmt(r.totalSol) + '</td><td>' + r.orderCount +
      '</td><td class="dim">' + esc(r.skipReason || r.lastError || '') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="dim">nenhuma execução ainda</td></tr>';
}
$('runNow').onclick = async (e) => {
  if (!confirm('Disparar a distribuição do lucro acumulado agora?')) return;
  e.target.disabled = true;
  try {
    const s = await api('/distribution/run-now', { method: 'POST', body: JSON.stringify({ ignoreMinimum: $('ignoreMin').checked }) });
    alert('Status: ' + s.status + (s.skipReason ? '\n' + s.skipReason : '\nSOL: ' + (Number(s.totalLamports) / 1e9)));
    loadAll();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Orders ──
async function loadOrders() {
  const d = await api('/orders?limit=25');
  document.querySelector('#ordTable tbody').innerHTML = d.orders.map((o) => {
    const cls = o.status === 'DISTRIBUTED' || o.status === 'SETTLED' ? 'ok' : (o.status === 'FAILED' ? 'err' : 'warn');
    return '<tr><td class="mono">' + new Date(o.createdAt).toLocaleString() + '</td><td class="' + cls + '">' + esc(o.status) +
      '</td><td>' + esc(o.fiat) + '</td><td class="mono">' + (o.feeBps == null ? '—' : o.feeBps + ' bps') +
      '</td><td class="mono">' + fmt(o.customerSol) + '</td><td class="mono">' + fmt(o.profitSol) +
      '</td><td class="dim">' + esc((o.lastError || '').slice(0, 60)) + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="dim">nenhuma ordem ainda</td></tr>';
}

async function loadAll() {
  try { await Promise.all([loadOverview(), loadSettings(), loadRecipients(), loadRuns(), loadOrders()]); }
  catch (e) {
    if (String(e.message).includes('unauthorized')) { sessionStorage.removeItem('adminKey'); location.reload(); }
    else console.error(e);
  }
}

if (KEY) { $('gate').classList.add('hide'); loadAll(); }
</script>
</body>
</html>`;
