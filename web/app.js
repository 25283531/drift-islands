/* 漂流岛屿 M1 原型前端：原生 JS + socket.io */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    token: localStorage.getItem('di_token') || '',
    character: null,
    ship: null,
    channels: { sea: null, island: null, active: null },
    encounter: null,
    island: null,
    combat: null,
    combatDeadline: 0,
    combatTimer: null,
    socket: null,
    seenRound: 0,
  };

  // ------------------------------------------------------------ 工具

  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function logLine({ who = '', text = '', cls = '' }) {
    const log = $('log');
    const row = document.createElement('div');
    row.className = `msg ${cls}`;
    if (who) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = who;
      row.appendChild(w);
    }
    const t = document.createElement('span');
    t.className = 'text';
    t.textContent = text;
    row.appendChild(t);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function clearLog() {
    $('log').innerHTML = '';
  }

  async function api(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { ...options, headers });
    return res.json();
  }

  function setConn(on) {
    const el = $('conn');
    el.className = `dot ${on ? 'on' : 'off'}`;
    el.textContent = on ? '已连接' : '未连接';
  }

  // ------------------------------------------------------------ 状态渲染

  function renderCharacter(character) {
    if (!character) return;
    state.character = character;
    $('hp-text').textContent = `${character.hp}/${character.max_hp}`;
    $('bar-hp').style.width = `${Math.max(0, Math.min(100, (character.hp / character.max_hp) * 100))}%`;
    $('position').textContent = `坐标 ${character.x.toFixed(1)}, ${character.y.toFixed(1)}`;
    $('island-box').classList.toggle('hidden', !character.island_id);
    if (character.island_id) {
      $('island-meta').textContent = state.island?.name ? `岛上：${state.island.name}` : '你在岛上';
    }
  }

  function renderShip(ship) {
    if (!ship) return;
    state.ship = ship;
    $('fuel-text').textContent = `${Number(ship.fuel).toFixed(0)}`;
    $('bar-fuel').style.width = `${Math.max(0, Math.min(100, (ship.fuel / 20) * 100))}%`;
  }

  function renderPosition(p) {
    if (!p) return;
    $('position').textContent = `坐标 ${Number(p.x).toFixed(1)}, ${Number(p.y).toFixed(1)}`;
    if (p.hp !== undefined) {
      $('hp-text').textContent = `${p.hp}/${p.max_hp}`;
      $('bar-hp').style.width = `${Math.max(0, Math.min(100, (p.hp / p.max_hp) * 100))}%`;
    }
    if (p.fuel !== undefined) renderShip({ ...(state.ship || {}), fuel: p.fuel });
    if (p.day_night) {
      const chip = $('daynight');
      chip.textContent = p.day_night === 'night' ? '夜晚' : '白天';
      chip.className = `chip ${p.day_night === 'night' ? 'night' : ''}`;
    }
    if (p.world_day !== undefined) {
      const hh = String(p.world_hour ?? 0).padStart(2, '0');
      $('world-time').textContent = `世界日 ${p.world_day} · ${hh}:00`;
    }
  }

  function renderChannel(channelId) {
    state.channels.active = channelId;
    const isIsland = channelId && channelId === state.channels.island;
    $('channel-name').textContent = isIsland ? '岛屿子频道' : '公共海频道';
    document.querySelectorAll('#channel-tabs button').forEach((b) => {
      b.classList.toggle('primary', b.dataset.channel === channelId);
    });
  }

  // ------------------------------------------------------------ 认证

  async function login() {
    const name = $('login-name').value.trim();
    if (name.length < 2) {
      $('auth-error').textContent = '显示名至少 2 个字';
      return;
    }
    $('auth-error').textContent = '';
    const data = await api('/api/v1/auth/session', { method: 'POST', body: JSON.stringify({ display_name: name }) });
    if (data.error) {
      $('auth-error').textContent = data.error.message;
      return;
    }
    state.token = data.token;
    localStorage.setItem('di_token', data.token);
    await afterLogin();
  }

  async function afterLogin() {
    const me = await api('/api/v1/me');
    if (me.error) {
      $('auth-error').textContent = me.error.message;
      return;
    }
    if (!me.characters || me.characters.length === 0) {
      $('char-step').classList.remove('hidden');
      $('auth-error').textContent = '';
      return;
    }
    connect(me.characters[0]);
  }

  async function createCharacter() {
    const name = $('char-name').value.trim();
    if (name.length < 2) {
      $('auth-error').textContent = '角色名至少 2 个字';
      return;
    }
    const data = await api('/api/v1/characters', { method: 'POST', body: JSON.stringify({ name }) });
    if (data.error) {
      $('auth-error').textContent = data.error.message;
      return;
    }
    connect(data.character);
  }

  // ------------------------------------------------------------ WebSocket

  function connect(character) {
    state.character = character;
    $('auth-modal').classList.add('hidden');

    const socket = io({ transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('connect', () => {
      setConn(true);
      socket.emit('auth', { token: state.token, character_id: character.id });
    });
    socket.on('disconnect', () => setConn(false));
    socket.on('connect_error', () => setConn(false));

    socket.on('authenticated', (data) => {
      state.character = data.character;
      state.ship = data.ship;
      state.channels = data.channels;
      renderTab();
      renderChannel(data.channels.active);
      renderCharacter(data.character);
      renderShip(data.ship);
      logLine({ who: '海', text: '你回到海上。频道里有人在说话，风把声音吹得断断续续。', cls: 'system' });
    });

    socket.on('character_update', (data) => renderCharacter(data.character));
    socket.on('ship_update', (data) => renderShip(data.ship));
    socket.on('position', renderPosition);

    socket.on('world_tick', (data) => {
      const hh = String(data.world_hour ?? 0).padStart(2, '0');
      $('world-time').textContent = `世界日 ${data.world_day} · ${hh}:00`;
      const chip = $('daynight');
      chip.textContent = data.day_night === 'night' ? '夜晚' : '白天';
      chip.className = `chip ${data.day_night === 'night' ? 'night' : ''}`;
    });

    socket.on('narration', (data) => {
      const kindClass = data.kind === 'combat_round' ? 'combat' : 'narration';
      logLine({ who: '叙述', text: data.text, cls: kindClass });
    });

    socket.on('encounter', (data) => {
      state.encounter = data;
      $('encounter-name').textContent = data.name;
      $('encounter-meta').textContent = `${data.distance_nm} 海里 · ${data.hint}`;
      $('encounter-box').classList.remove('hidden');
      toast(`遭遇 ${data.name}`, 'warn');
    });

    socket.on('warning', (data) => toast(data.text, data.type === 'content_violation' ? 'error' : 'warn'));
    socket.on('error', (data) => toast(data.message, 'error'));

    socket.on('channel_changed', (data) => {
      if (data.island_id) state.island = { id: data.island_id, name: state.encounter?.name || '岛屿' };
      else state.island = null;
      renderChannel(data.channel_id);
      if (data.island_id) $('encounter-box').classList.add('hidden');
    });

    socket.on('command_action', (data) => {
      if (data?.emit) socket.emit(data.emit, data.payload || {});
    });

    socket.on('chat_history', (data) => {
      clearLog();
      (data.messages || []).forEach((m) => renderMessage(data.channel_id, m, 'visible'));
      logLine({ who: '海', text: '—— 以上是之前的消息 ——', cls: 'system' });
    });

    socket.on('chat_message', (data) => renderMessage(data.channel_id, data.message, data.visibility));

    socket.on('combat_round_start', (data) => {
      state.combat = data;
      $('combat-box').classList.remove('hidden');
      $('combat-round').textContent = data.round;
      state.combatDeadline = Date.now() + data.deadline_ms;
      renderParticipants(data.participants);
      startCombatTimer();
      setCombatButtons(true);
      logLine({ who: '战斗', text: `第 ${data.round} 回合开始，15 秒内提交行动。直接发「攻击」「防御」或「逃跑」也行。`, cls: 'combat' });
    });

    socket.on('combat_round_result', (data) => {
      renderParticipants(data.results.map((r) => ({ ...r, max_hp: r.max_hp, level: '' })));
      logLine({ who: '战斗', text: `第 ${data.round} 回合：${data.narration}`, cls: 'combat' });
      setCombatButtons(true);
    });

    socket.on('combat_finished', (data) => {
      stopCombatTimer();
      setCombatButtons(false);
      $('combat-box').classList.add('hidden');
      state.combat = null;
      logLine({ who: '战斗', text: data.narration, cls: 'combat' });
    });

    socket.on('channel_changed', () => {});

    // ---------------- M2：造岛 / 收集 / 晶核 / 基地
    socket.on('island_create_question', (q) => renderCreateQuestion(q));
    socket.on('island_create_summary', (s) => renderCreateSummary(s));
    socket.on('island_created', (data) => {
      $('m2-content').classList.add('hidden');
      toast(`岛屿「${data.name}」已落成，坐标未知`, 'warn');
      logLine({ who: '叙述', text: data.summary, cls: 'narration' });
    });
    socket.on('arbitration_result', (r) => {
      const label = r.outcome === 'success' ? '得手' : r.outcome === 'failure' ? '失手' : '空手';
      logLine({
        who: '判定',
        text: `${label}：${r.narration}（成功率 ${Math.round((r.chance || 0) * 100)}%，掷值 ${r.roll ?? 0}）`,
        cls: 'narration',
      });
    });
    socket.on('crystal_absorbed', (r) => {
      logLine({ who: '晶核', text: r.narration, cls: 'system' });
      toast(`吸收 ${r.gained} 单位能量`, 'warn');
    });
    socket.on('crystals', (data) => renderCrystals(data.items || []));
    socket.on('base_update', (data) => {
      if (data.base) toast(`基地：防御 ${data.base.defense_lv} · 储物 ${data.base.storage_lv} · 设施 ${data.base.facility_lv}`, 'warn');
    });
    socket.on('island_panel', (data) => renderPanel(data));

    // ---------------- M3：团队 / PvP / 交易 / 技能 / 疲劳 / 保护期
    socket.on('team_update', (d) => m3Render('队伍', d));
    socket.on('team_boarded', (d) => {
      m3Render('上船', d);
      if (d.text) toast(d.text);
    });
    socket.on('team_invited', (d) => {
      m3Render('邀请', d);
      toast(`已邀请 ${d.target} 加入「${d.team}」`, 'warn');
    });
    socket.on('skills_update', (d) => m3Render('技能', d));
    socket.on('trade_offered', (d) => m3Render('交易邀请', d));
    socket.on('trade_list', (d) => m3Render('待处理交易', d));
    socket.on('trade_result', (d) => {
      m3Render('交易结果', d);
      if (d.narration) logLine({ who: '交易', text: d.narration, cls: 'narration' });
    });
    socket.on('fatigue_update', (d) => {
      m3Render('状态', d);
      if (d.warning) toast(d.warning, 'warn');
    });
    socket.on('protection_update', (d) => m3Render('保护期', d));
    socket.on('pvp_result', (d) => {
      m3Render('决斗', d);
      if (d.narration) logLine({ who: '战斗', text: d.narration, cls: 'narration' });
    });
    socket.on('base_attack_result', (d) => {
      m3Render('攻击基地', d);
      if (d.narration) logLine({ who: '战斗', text: d.narration, cls: 'narration' });
    });
    socket.on('capture_update', (d) => {
      m3Render('占领', d);
      if (d.narration) logLine({ who: '占领', text: d.narration, cls: 'narration' });
    });
    socket.on('dead_drop_placed', (d) => {
      m3Render('藏匿点', d);
      toast('东西已藏好，附近的人都能拿走', 'warn');
    });
    socket.on('dead_drop_result', (d) => {
      m3Render('取出', d);
      if (d.narration) toast(d.narration);
    });
    socket.on('monster_offer', (d) => m3Render('它的条件', d));
    socket.on('monster_trade_result', (d) => {
      m3Render('怪物交易', d);
      if (d.narration) logLine({ who: '交易', text: d.narration, cls: 'narration' });
    });
  }

  // ------------------------------------------------------------ M2 UI

  function m2Show() {
    $('m2-content').classList.remove('hidden');
    return $('m2-content');
  }

  let currentQuestion = null;

  function renderCreateQuestion(q) {
    currentQuestion = q;
    const box = m2Show();
    box.innerHTML = '';
    const title = document.createElement('p');
    title.className = 'muted';
    title.textContent = `造岛问答 ${q.index + 1}/${q.total}`;
    const text = document.createElement('p');
    text.textContent = q.text;
    const input = document.createElement('input');
    input.id = 'm2-answer';
    input.maxLength = 200;
    input.placeholder = '输入回答，可跳过的题留空';
    const row = document.createElement('div');
    row.className = 'btn-row';
    const send = document.createElement('button');
    send.className = 'primary';
    send.textContent = '下一题';
    send.onclick = () => {
      state.socket.emit('island_create_answer', { question_id: q.question_id, answer: input.value.trim() });
      input.value = '';
    };
    const skip = document.createElement('button');
    skip.textContent = '跳过';
    skip.onclick = () => state.socket.emit('island_create_answer', { question_id: q.question_id, answer: '' });
    row.append(send, skip);
    box.append(title, text, input, row);
    input.focus();
  }

  function renderCreateSummary(s) {
    const box = m2Show();
    box.innerHTML = '';
    const draft = s.draft || {};
    const lines = [
      `岛名：${draft.name || '—'}`,
      `描述：${draft.description || '—'}`,
      `规则：${(draft.rules || []).join('；') || '—'}`,
      `资源：${draft.resource_direction || '—'}`,
      `怪物：${(draft.monsters || []).map((m) => `${m.name || '怪物'} Lv.${m.max_level} × ${m.count}`).join('、') || '—'}`,
    ];
    lines.forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      box.appendChild(p);
    });
    if ((s.issues || []).length > 0) {
      const issue = document.createElement('p');
      issue.className = 'error';
      issue.textContent = s.issues.map((i) => i.message).join('；');
      box.appendChild(issue);
    }
    const row = document.createElement('div');
    row.className = 'btn-row';
    const confirm = document.createElement('button');
    confirm.className = 'primary';
    confirm.textContent = '确认创建';
    confirm.onclick = () => state.socket.emit('island_create_confirm');
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => {
      state.socket.emit('island_create_cancel');
      box.classList.add('hidden');
    };
    row.append(confirm, cancel);
    box.appendChild(row);
  }

  function renderCrystals(items) {
    const box = m2Show();
    box.innerHTML = '';
    if (items.length === 0) {
      const p = document.createElement('p');
      p.textContent = '你身上没有晶核。击败怪物才会掉落。';
      box.appendChild(p);
      return;
    }
    items.forEach((crystal) => {
      const row = document.createElement('div');
      row.className = 'btn-row';
      const label = document.createElement('span');
      label.textContent = `${crystal.level} 级晶核 · ${crystal.energy_remaining}/${crystal.energy_total}`;
      const absorb = document.createElement('button');
      absorb.textContent = '吸收';
      absorb.onclick = () => state.socket.emit('crystal_absorb', { crystal_id: crystal.id });
      row.append(label, absorb);
      box.appendChild(row);
    });
  }

  function renderPanel(data) {
    const box = m2Show();
    box.innerHTML = '';
    const rows = [
      `岛名：${data.name}`,
      `访问次数：${data.visit_count}`,
      `被拿走资源：${data.resources_taken}`,
      `防御：${data.defense_power} · 火力：${data.firepower}`,
      `怪物：${data.monster_count} 只（最高 ${data.max_monster_level} 级）`,
      `基地：${data.base ? `防御 ${data.base.defense_lv} · 储物 ${data.base.storage_lv} · 设施 ${data.base.facility_lv}` : '未建'}`,
      `坐标：不可见（防自肥）`,
    ];
    rows.forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      box.appendChild(p);
    });
  }

  function renderUpgrade() {
    const box = m2Show();
    box.innerHTML = '';
    const tracks = [
      ['defense', '防御线'],
      ['weapon', '武器线'],
      ['living', '生活线'],
      ['research', '科研线'],
    ];
    tracks.forEach(([track, label]) => {
      const row = document.createElement('div');
      row.className = 'btn-row';
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.textContent = '升级';
      btn.onclick = () => state.socket.emit('ship_upgrade', { track });
      row.append(name, btn);
      box.appendChild(row);
    });
  }

  function renderTab() {
    const tabs = $('channel-tabs');
    tabs.innerHTML = '';
    const sea = document.createElement('button');
    sea.textContent = '海频道';
    sea.dataset.channel = state.channels.sea;
    sea.onclick = () => renderChannel(state.channels.sea);
    tabs.appendChild(sea);
    if (state.channels.island) {
      const island = document.createElement('button');
      island.textContent = '岛屿';
      island.dataset.channel = state.channels.island;
      island.onclick = () => renderChannel(state.channels.island);
      tabs.appendChild(island);
    }
  }

  function renderMessage(channelId, message, visibility) {
    if (!message) return;
    const active = state.channels.active;
    if (channelId !== active) return;
    if (message.kind === 'system') {
      logLine({ who: '系统', text: message.content, cls: 'system' });
      return;
    }
    if (message.kind === 'ai') {
      logLine({ who: 'AI', text: message.content, cls: 'ai' });
      return;
    }
    const cls = visibility === 'quarantined' ? 'quarantined' : '';
    const who = visibility === 'quarantined' ? '（仅你可见）' : '玩家';
    logLine({ who, text: message.content, cls });
  }

  // ------------------------------------------------------------ 战斗 UI

  function renderParticipants(list) {
    const ul = $('combat-participants');
    ul.innerHTML = '';
    (list || []).forEach((p) => {
      const li = document.createElement('li');
      li.className = `${p.side === 'player' ? 'player' : ''} ${p.hp <= 0 ? 'dead' : ''}`;
      const name = document.createElement('b');
      name.textContent = p.name;
      const hp = document.createElement('span');
      hp.textContent = `${p.hp}/${p.max_hp}`;
      li.append(name, hp);
      ul.appendChild(li);
    });
  }

  function startCombatTimer() {
    stopCombatTimer();
    state.combatTimer = setInterval(() => {
      const left = Math.max(0, Math.round((state.combatDeadline - Date.now()) / 1000));
      $('combat-timer').textContent = `${left}s`;
    }, 200);
  }

  function stopCombatTimer() {
    if (state.combatTimer) clearInterval(state.combatTimer);
    state.combatTimer = null;
  }

  function setCombatButtons(enabled) {
    ['btn-attack', 'btn-defend', 'btn-flee'].forEach((id) => {
      $(id).disabled = !enabled;
    });
  }

  function combatAction(action) {
    if (!state.combat) return;
    let target;
    if (action === 'attack') {
      target = state.combat.participants?.find?.((p) => p.side === 'monster' && (p.hp ?? 1) > 0)?.id;
    }
    state.socket.emit('combat_action', { combat_id: state.combat.combat_id, action, target_id: target });
    setCombatButtons(false);
  }

  // ------------------------------------------------------------ 事件绑定

  $('btn-login').onclick = login;
  $('btn-create').onclick = createCharacter;
  $('login-name').addEventListener('keydown', (e) => e.key === 'Enter' && login());
  $('char-name').addEventListener('keydown', (e) => e.key === 'Enter' && createCharacter());

  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !state.socket) return;
    state.socket.emit('chat', { channel_id: state.channels.active || state.channels.sea, text });
    input.value = '';
  };

  $('angle').oninput = () => ($('angle-val').textContent = `${$('angle').value}°`);
  $('distance').oninput = () => ($('distance-val').textContent = $('distance').value);

  $('btn-move').onclick = () => {
    if (!state.socket) return;
    state.socket.emit('move', { angle: Number($('angle').value), distance_nm: Number($('distance').value) });
  };
  $('btn-drift').onclick = () => {
    if (!state.socket) return;
    state.socket.emit('drift', {});
  };
  $('btn-nearby').onclick = async () => {
    const p = state.character;
    if (!p) return;
    const data = await api(`/api/v1/islands/nearby?x=${p.x}&y=${p.y}&r=50`);
    const box = $('nearby-box');
    const list = $('nearby-list');
    list.innerHTML = '';
    if (!data.islands || data.islands.length === 0) {
      list.innerHTML = '<li><span>五十海里内没有岛影</span></li>';
    } else {
      data.islands.forEach((island) => {
        const li = document.createElement('li');
        const name = document.createElement('b');
        name.textContent = island.name;
        const meta = document.createElement('span');
        meta.textContent = `${island.direction_text} · ${island.distance_nm} 海里`;
        li.append(name, meta);
        li.onclick = () => {
          state.encounter = {
            island_id: island.id,
            name: island.name,
            distance_nm: island.distance_nm,
            hint: `${island.direction_text}方向`,
          };
          $('encounter-name').textContent = island.name;
          $('encounter-meta').textContent = `${island.distance_nm} 海里 · ${island.direction_text}方向`;
          $('encounter-box').classList.remove('hidden');
        };
        list.appendChild(li);
      });
    }
    box.classList.remove('hidden');
  };

  $('btn-enter').onclick = () => {
    if (!state.encounter || !state.socket) return;
    state.socket.emit('enter_island', { island_id: state.encounter.island_id });
  };
  $('btn-leave').onclick = () => state.socket && state.socket.emit('leave_island', {});

  $('btn-attack').onclick = () => combatAction('attack');
  $('btn-defend').onclick = () => combatAction('defend');
  $('btn-flee').onclick = () => combatAction('flee');

  // M2 按钮
  $('btn-island-create').onclick = () => state.socket && state.socket.emit('island_create_start');
  $('btn-collect').onclick = () => {
    if (!state.socket) return;
    const intent = prompt('你想搜刮什么？（例如：燃料、药品、零件）', '燃料');
    if (intent === null) return;
    state.socket.emit('collect', { intent });
  };
  $('btn-crystals').onclick = () => state.socket && state.socket.emit('crystals');
  $('btn-upgrade').onclick = renderUpgrade;
  $('btn-settle').onclick = () => {
    const islandId = state.island?.id || state.character?.island_id;
    if (!islandId) return toast('先上岛再驻扎', 'warn');
    state.socket.emit('settle', { island_id: islandId });
  };
  $('btn-panel').onclick = () => {
    const islandId = state.island?.id || state.character?.island_id;
    if (!islandId) return toast('先上岛再看面板', 'warn');
    state.socket.emit('island_panel', { island_id: islandId });
  };

  // M3 入口
  $('btn-team').onclick = () => {
    const name = window.prompt('队伍名字（2–12 字）');
    if (name) state.socket.emit('team_create', { name });
  };
  $('btn-team-info').onclick = () => state.socket.emit('team_info');
  $('btn-skills').onclick = () => state.socket.emit('skills');
  $('btn-fatigue').onclick = () => state.socket.emit('heartbeat');
  $('btn-capture').onclick = () => {
    const islandId = state.island?.id || state.character?.island_id;
    if (!islandId) return toast('先在岛上', 'warn');
    state.socket.emit('capture_status', { island_id: islandId });
  };
  $('btn-protection').onclick = () => state.socket.emit('protection_status');

  function m3Render(title, data) {
    const box = $('m3-content');
    box.classList.remove('hidden');
    box.innerHTML = `<h4>${title}</h4><pre></pre>`;
    box.querySelector('pre').textContent = JSON.stringify(data, null, 2);
  }

  // 有 token 时自动续登
  if (state.token) {
    afterLogin().catch(() => {
      localStorage.removeItem('di_token');
      state.token = '';
    });
  }
})();
