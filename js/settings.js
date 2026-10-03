// Settings page (agent mode, on the PC running the agent): edits agent/config.json through the agent API.
// The Vibepollo password is write-only: the agent never sends it back, and an empty field keeps it.
SS.Settings = (() => {
  const esc = s => SS.fmt.esc(s);
  const api = async (method, path, body) => {
    const r = await fetch(path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  };
  const lines = v => String(v || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  async function render(el, opts) {
    el.innerHTML = `<section class="panel"><p class="muted">Wczytuję ustawienia agenta…</p></section>`;
    let cfg;
    try { cfg = await api('GET', 'api/config'); }
    catch (e) {
      el.innerHTML = `<section class="panel"><h2>Ustawienia</h2><p class="notice err">${esc(e.message)}</p></section>`;
      return;
    }
    const vp = cfg.vibepollo, st = cfg.steam, cl = cfg.client_logs, tw = cfg.streamtweak;
    const check = (id, on, label) => `<label class="field check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
    const text = (id, val, label, attrs = '') => `<label class="field">${label}<input class="t wide" id="${id}" value="${esc(val || '')}" ${attrs}></label>`;
    const area = (id, val, label, hint) => `<label class="field">${label}<textarea class="t wide" id="${id}" rows="2" spellcheck="false">${esc((val || []).join('\n'))}</textarea><span class="small muted">${hint}</span></label>`;
    el.innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>Stan agenta</h2>
          <div class="actions"><button class="small" type="button" id="setShortcut">Utwórz skrót na pulpicie</button><button class="small" type="button" id="setRestart">Zrestartuj agenta</button></div></div>
        <div id="setStatus" style="min-width:0;overflow-wrap:anywhere">${opts.statusHtml()}</div>
        <p class="caveat">Ustawienia zmienia się tylko na tym komputerze. Plik: <span class="mono">${esc(cfg.config_path)}</span></p>
      </section>

      <section class="panel" aria-labelledby="sVp">
        <h2 id="sVp">Vibepollo (host)</h2>
        ${check('vpOn', vp.enabled !== false, 'Pobieraj historię sesji z panelu Vibepollo')}
        <div class="settings-grid">
          ${text('vpUrl', vp.url, 'Adres panelu')}
          ${text('vpUser', vp.username, 'Login', 'autocomplete="off"')}
          <label class="field">Hasło<input class="t wide" id="vpPass" type="password" autocomplete="new-password" placeholder="${vp.has_password ? '•••••• zapisane, zostaw puste bez zmian' : 'nie ustawione'}"></label>
        </div>
        ${area('vpImport', vp.import_dirs, 'Import starych eksportów (jeden folder w linii)', 'Pliki sunshine-session-*.json pobrane kiedyś ręcznie z panelu. Nowe sesje agent bierze bezpośrednio z panelu.')}
        <div class="actions"><button type="button" id="testVp">Testuj połączenie z Vibepollo</button><span class="small" id="testVpMsg"></span></div>
      </section>

      <section class="panel" aria-labelledby="sCl">
        <h2 id="sCl">Klient (K12)</h2>
        ${check('clOn', cl.enabled !== false, 'Zbieraj logi z klienta')}
        ${area('clDirs', cl.dirs, 'Foldery z logami StreamLight/Moonlight', 'Udostępniony folder Temp klienta, np. \\\\10.10.10.177\\StreamLightLogs. Agent obserwuje go i kopiuje logi od razu po zmianie.')}
        ${area('clVrr', cl.vrr_dirs, 'Foldery diagnostyki VRR Moonlighta', 'Np. \\\\10.10.10.177\\moonlight-vrr-diagnostics. Dane klatka po klatce.')}
      </section>

      <section class="panel" aria-labelledby="sOt">
        <h2 id="sOt">Pozostałe źródła</h2>
        ${check('stOn', st.enabled !== false, 'Steam Remote Play')}
        ${text('stDir', st.logs_dir, 'Folder logów Steama')}
        ${check('twOn', tw.enabled !== false, 'Historia StreamTweak')}
        ${text('twPath', tw.path, 'Plik historii StreamTweak')}
        <label class="field">Dodatkowe sprawdzanie co (minuty, 0 = tylko przy starcie i przycisku)<input class="t" id="every" type="number" min="0" value="${esc(cfg.check_every_minutes || 0)}"></label>
      </section>

      <section class="panel">
        <div class="actions">
          <button type="button" id="testPaths">Sprawdź foldery</button>
          <button class="primary" type="button" id="saveCfg">Zapisz i zrestartuj agenta</button>
          <span class="small" id="saveMsg"></span>
        </div>
        <div id="pathResults"></div>
      </section>`;

    const $ = s => el.querySelector(s);
    const collect = () => ({
      vibepollo: { enabled: $('#vpOn').checked, url: $('#vpUrl').value, username: $('#vpUser').value, password: $('#vpPass').value, import_dirs: lines($('#vpImport').value) },
      client_logs: { enabled: $('#clOn').checked, dirs: lines($('#clDirs').value), vrr_dirs: lines($('#clVrr').value) },
      steam: { enabled: $('#stOn').checked, logs_dir: $('#stDir').value },
      streamtweak: { enabled: $('#twOn').checked, path: $('#twPath').value },
      check_every_minutes: +$('#every').value || 0
    });
    const msg = (sel, text, ok) => { const m = $(sel); m.textContent = text; m.className = 'small ' + (ok === true ? 's-ok' : ok === false ? 's-crit' : 'muted'); };

    $('#testVp').onclick = async () => {
      msg('#testVpMsg', 'Łączę…');
      try { const r = await api('POST', 'api/test/vibepollo', { url: $('#vpUrl').value, username: $('#vpUser').value, password: $('#vpPass').value }); msg('#testVpMsg', r.msg, r.ok); }
      catch (e) { msg('#testVpMsg', e.message, false); }
    };
    $('#testPaths').onclick = async () => {
      const c = collect();
      const paths = [...c.client_logs.dirs.map(p => ['client', p]), ...c.client_logs.vrr_dirs.map(p => ['vrr', p]), ['steam', c.steam.logs_dir], ['streamtweak', c.streamtweak.path], ...c.vibepollo.import_dirs.map(p => ['import', p])];
      $('#pathResults').innerHTML = '<p class="muted small">Sprawdzam…</p>';
      try {
        const res = await api('POST', 'api/test/paths', { paths });
        $('#pathResults').innerHTML = `<table><tbody>${res.map(r => `<tr><td class="mono small">${esc(r.path)}</td><td class="small ${r.ok ? 's-ok' : 's-crit'}">${r.ok ? '✓' : '✗'} ${esc(r.msg)}</td></tr>`).join('')}</tbody></table>`;
      } catch (e) { $('#pathResults').innerHTML = `<p class="notice err">${esc(e.message)}</p>`; }
    };
    const restart = async () => {
      msg('#saveMsg', 'Restartuję agenta…');
      try { await api('POST', 'api/restart'); } catch (e) { /* the connection may drop as it restarts */ }
      // Wait for the new agent, then reload so every view uses the new settings.
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 750));
        try { const r = await fetch('api/info', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch (e) { /* not up yet */ }
      }
      msg('#saveMsg', 'Agent nie wrócił. Uruchom agent\\start-agent.cmd.', false);
    };
    $('#saveCfg').onclick = async () => {
      msg('#saveMsg', 'Zapisuję…');
      try { await api('PUT', 'api/config', collect()); $('#vpPass').value = ''; await restart(); }
      catch (e) { msg('#saveMsg', 'Nie zapisano: ' + e.message, false); }
    };
    $('#setRestart').onclick = restart;
    $('#setShortcut').onclick = async () => {
      try { const r = await api('POST', 'api/shortcut'); $('#setShortcut').textContent = 'Skrót utworzony ✓'; $('#setShortcut').title = r.path; }
      catch (e) { $('#setShortcut').textContent = 'Nie udało się: ' + e.message; }
    };
  }

  return { render };
})();
