(function(){
  function syncSize(){
    document.documentElement.style.setProperty('--app-w', window.innerWidth+'px');
    document.documentElement.style.setProperty('--app-h', window.innerHeight+'px');
  }
  syncSize();
  window.addEventListener('resize', syncSize);
  window.addEventListener('orientationchange', ()=> setTimeout(syncSize,50));
  if(window.visualViewport){ window.visualViewport.addEventListener('resize', syncSize); }

  let wakeLock = null;
  async function requestWakeLock(){
    try{
      if('wakeLock' in navigator){ wakeLock = await navigator.wakeLock.request('screen'); }
    }catch(e){ /* not supported / denied */ }
  }
  requestWakeLock();
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible') requestWakeLock();
  });
  document.addEventListener('pointerdown', ()=>{ if(!wakeLock) requestWakeLock(); }, {passive:true});

  const state = { a:0, b:0, seconds:0, running:false };
  let timerInterval = null;

  const scoreEl = { a: document.getElementById('scoreA'), b: document.getElementById('scoreB') };
  const panelEl = { a: document.getElementById('panelA'), b: document.getElementById('panelB') };
  const nameEl  = { a: document.getElementById('nameA'), b: document.getElementById('nameB') };
  const timerEl = document.getElementById('timer');

  // --- auto-save (rede de segurança contra a aba ser descartada pelo sistema testado no Android e Iphone) ---
  const STORAGE_KEY = 'placar-volei-state-v1';
  let activeMatchKey = null;
  function saveState(){
    try{
      const css = getComputedStyle(document.documentElement);
      ArmazenamentoLocal.setItem(STORAGE_KEY, JSON.stringify({
        a: state.a, b: state.b, seconds: state.seconds, running: state.running,
        matchKey: activeMatchKey,
        nameA: nameEl.a.textContent, nameB: nameEl.b.textContent,
        colorA: css.getPropertyValue('--team-a').trim(),
        colorADim: css.getPropertyValue('--team-a-dim').trim(),
        colorB: css.getPropertyValue('--team-b').trim(),
        colorBDim: css.getPropertyValue('--team-b-dim').trim()
      }));
    }catch(e){ /* localStorage indisponível (ex: modo privado) — ignora */ }
  }
  function loadState(){
    const partida = readActiveMatch();
    activeMatchKey = partida ? partida.chave : null;
    try{
      const raw = ArmazenamentoLocal.getItem(STORAGE_KEY);
      if(!raw){
        if(partida){
          nameEl.a.textContent = partida.nomes[0];
          nameEl.b.textContent = partida.nomes[1];
          saveState();
        }
        return;
      }
      const s = JSON.parse(raw);
      const mesmaPartida = !partida || s.matchKey === partida.chave;
      state.a = mesmaPartida ? (s.a||0) : 0;
      state.b = mesmaPartida ? (s.b||0) : 0;
      state.seconds = mesmaPartida ? (s.seconds||0) : 0;
      scoreEl.a.textContent = state.a; scoreEl.b.textContent = state.b;
      fitScore('a'); fitScore('b');
      timerEl.textContent = fmt(state.seconds);
      if(partida){
        nameEl.a.textContent = partida.nomes[0];
        nameEl.b.textContent = partida.nomes[1];
      }else{
        if(s.nameA) nameEl.a.textContent = s.nameA;
        if(s.nameB) nameEl.b.textContent = s.nameB;
      }
      if(s.colorA) document.documentElement.style.setProperty('--team-a', s.colorA);
      if(s.colorADim) document.documentElement.style.setProperty('--team-a-dim', s.colorADim);
      if(s.colorB) document.documentElement.style.setProperty('--team-b', s.colorB);
      if(s.colorBDim) document.documentElement.style.setProperty('--team-b-dim', s.colorBDim);
      if(s.running && mesmaPartida) startTimer();
      if(partida && !mesmaPartida) saveState();
    }catch(e){ /* estado salvo corrompido — ignora e segue com o padrão */ }
  }
  function clearState(){
    try{ ArmazenamentoLocal.removeItem(STORAGE_KEY); }catch(e){}
  }

  // --- equipes da partida atual (salvas pelo acompanhamento do sorteio) ---
  const TRACKER_STORAGE_KEY = 'sorteio-acompanhamento-v1';
  const END_MATCH_REQUEST_KEY = 'placar-encerrar-partida-v1';
  function readActiveMatch(){
    try{
      const salvo = JSON.parse(ArmazenamentoLocal.getItem(TRACKER_STORAGE_KEY) || 'null');
      if(!salvo || !salvo.plano || !salvo.estado) return null;
      const indice = salvo.estado.faseAtual;
      const fase = salvo.plano.fases && salvo.plano.fases[indice];
      const andamento = salvo.estado.fases && salvo.estado.fases[indice];
      if(!fase || !andamento || !Array.isArray(andamento.quadra) || andamento.quadra.length !== 2) return null;
      if(fase.modo === 'jogo' && andamento.vencedor !== null && andamento.vencedor !== undefined) return null;
      const nomes = andamento.quadra.map(id => fase.times[id] && fase.times[id].join(' + '));
      if(nomes.some(nome => !nome)) return null;
      return {
        nomes: nomes,
        planoId: salvo.plano.id || '',
        faseAtual: indice,
        jogos: andamento.jogos || 0,
        quadra: andamento.quadra.slice(),
        chave: JSON.stringify([salvo.plano.id || '', indice, andamento.jogos || 0, nomes])
      };
    }catch(e){ return null; }
  }
  function syncActiveMatch(){
    const partida = readActiveMatch();
    if(!partida) return;
    let chaveSalva = null;
    try{
      const salvo = JSON.parse(ArmazenamentoLocal.getItem(STORAGE_KEY) || 'null');
      chaveSalva = salvo && salvo.matchKey;
    }catch(e){}
    if(activeMatchKey === partida.chave){
      nameEl.a.textContent = partida.nomes[0];
      nameEl.b.textContent = partida.nomes[1];
      return;
    }
    const partidaMudou = chaveSalva !== partida.chave;
    activeMatchKey = partida.chave;
    nameEl.a.setAttribute('contenteditable','false');
    nameEl.b.setAttribute('contenteditable','false');
    nameEl.a.textContent = partida.nomes[0];
    nameEl.b.textContent = partida.nomes[1];
    if(partidaMudou){
      state.a = 0; state.b = 0; state.seconds = 0; state.running = false;
      clearInterval(timerInterval);
      timerInterval = null;
      timerEl.classList.remove('running');
      scoreEl.a.textContent = '0'; scoreEl.b.textContent = '0';
      fitScore('a'); fitScore('b');
      timerEl.textContent = '00:00';
    }
    saveState();
  }
  function fmt(s){
    const m = Math.floor(s/60).toString().padStart(2,'0');
    const r = (s%60).toString().padStart(2,'0');
    return m+':'+r;
  }
  function startTimer(){
    if(state.running) return;
    state.running = true;
    timerEl.classList.add('running');
    timerInterval = setInterval(()=>{
      state.seconds++;
      timerEl.textContent = fmt(state.seconds);
      saveState();
    },1000);
    saveState();
  }
  function pauseTimer(){
    state.running = false;
    timerEl.classList.remove('running');
    clearInterval(timerInterval);
    saveState();
  }
  timerEl.addEventListener('click', ()=> state.running ? pauseTimer() : startTimer());

  function pulse(key){
    scoreEl[key].classList.add('pulse');
    setTimeout(()=>scoreEl[key].classList.remove('pulse'),120);
  }
 function fitScore(key){
    const digits = String(state[key]).length;
    const scale = digits <= 2 ? 1 : digits === 3 ? 0.72 : 0.55;
    scoreEl[key].style.setProperty('--s', scale);
  }
  function addPoint(key, delta){
    state[key] = Math.max(0, state[key]+delta);
    scoreEl[key].textContent = state[key];
    pulse(key);
    fitScore(key);
    if(!state.running) startTimer();
    saveState();
  }

  panelEl.a.addEventListener('click', ()=> addPoint('a', 1));
  panelEl.b.addEventListener('click', ()=> addPoint('b', 1));

  document.querySelectorAll('.stepper button').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      addPoint(btn.dataset.key, parseInt(btn.dataset.delta,10));
    });
  });

  [ ['a', nameEl.a], ['b', nameEl.b] ].forEach(([key, el])=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      if(activeMatchKey) return;
      el.setAttribute('contenteditable','true');
      el.focus();
      document.execCommand('selectAll', false, null);
    });
    el.addEventListener('blur', ()=>{
      el.setAttribute('contenteditable','false');
      if(!el.textContent.trim()) el.textContent = key==='a' ? 'Time 1' : 'Time 2';
      saveState();
    });
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
  });

  const PALETTE = ['#2F6FED','#E5484D','#2FB67C','#B23FED','#F2A93B','#3FA9F5'];
  function shade(hex, factor){
    const n = parseInt(hex.slice(1),16);
    const r = Math.round(((n>>16)&255)*factor);
    const g = Math.round(((n>>8)&255)*factor);
    const b = Math.round((n&255)*factor);
    return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function setupPicker(team, dotsBtnId, swatchesId){
    const btn = document.getElementById(dotsBtnId);
    const box = document.getElementById(swatchesId);
    PALETTE.forEach(c=>{
      const sw = document.createElement('div');
      sw.className = 'swatch';
      sw.style.background = c;
      sw.addEventListener('click', e=>{
        e.stopPropagation();
        document.documentElement.style.setProperty('--team-'+team, c);
        document.documentElement.style.setProperty('--team-'+team+'-dim', shade(c,0.62));
        box.classList.remove('open');
        saveState();
      });
      box.appendChild(sw);
    });
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      box.classList.toggle('open');
    });
  }
  setupPicker('a','dotsA','swatchesA');
  setupPicker('b','dotsB','swatchesB');
  document.addEventListener('click', ()=>{
    document.getElementById('swatchesA').classList.remove('open');
    document.getElementById('swatchesB').classList.remove('open');
  });

  const overlay = document.getElementById('modalOverlay');
  const resetMessage = document.getElementById('resetMessage');
  const confirmReset = document.getElementById('confirmReset');
  function resetScore(){
    state.a = 0; state.b = 0; state.seconds = 0;
    scoreEl.a.textContent = 0; scoreEl.b.textContent = 0;
    pauseTimer();
    timerEl.textContent = '00:00';
    overlay.classList.remove('open');
    saveState();
  }
  document.getElementById('resetBtn').addEventListener('click', ()=>{
    const partida = readActiveMatch();
    resetMessage.textContent = partida
      ? 'Deseja encerrar a partida? O time com mais pontos será marcado como vencedor.'
      : 'Não há sorteio em andamento. Deseja zerar o placar e o cronômetro?';
    confirmReset.textContent = partida ? 'Encerrar' : 'Zerar';
    overlay.classList.add('open');
  });
  document.getElementById('cancelReset').addEventListener('click', ()=> overlay.classList.remove('open'));
  confirmReset.addEventListener('click', ()=>{
    const partida = readActiveMatch();
    if(partida){
      if(activeMatchKey !== partida.chave){
        overlay.classList.remove('open');
        syncActiveMatch();
        alert('A partida mudou. Confira o placar atualizado antes de encerrar.');
        return;
      }
      if(state.a === state.b){
        overlay.classList.remove('open');
        alert('O placar está empatado. Some pontos para definir um vencedor antes de encerrar.');
        return;
      }
      const pedido = {
        id: 'encerrar-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        planoId: partida.planoId,
        faseAtual: partida.faseAtual,
        jogos: partida.jogos,
        quadra: partida.quadra,
        idVencedor: partida.quadra[state.a > state.b ? 0 : 1]
      };
      try{
        ArmazenamentoLocal.setItem(END_MATCH_REQUEST_KEY, JSON.stringify(pedido));
      }catch(e){
        alert('Não foi possível registrar o vencedor neste aparelho. O placar foi mantido.');
        return;
      }
      if(!window.Fila || !window.Fila.processarPedidoPendente()){
        overlay.classList.remove('open');
        alert('Não foi possível registrar o vencedor. O placar foi mantido.');
        return;
      }
      syncActiveMatch();
    }
    resetScore();
  });

  ArmazenamentoLocal.subscribe(evento => {
    if (evento.key === TRACKER_STORAGE_KEY) syncActiveMatch();
  });
  ArmazenamentoLocal.ready.then(()=>{
    loadState();
    syncActiveMatch();
  });
  //Esse trecho abaixo de instalação não sei se funciona no Iphone
  const installBtn = document.getElementById('installBtn');
  const installOverlay = document.getElementById('installOverlay');
  const installText = document.getElementById('installText');
  const installConfirm = document.getElementById('installConfirm');

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e=>{
    e.preventDefault();
    deferredPrompt = e;
  });

  if(isMobile && !isStandalone) installBtn.classList.remove('hidden');

  installBtn.addEventListener('click', ()=>{
    if(isIOS){
      installText.textContent = 'No iPhone/iPad: toque no ícone de Compartilhar (□ com seta pra cima) na barra do Safari e depois em "Adicionar à Tela de Início".';
      installConfirm.style.display = 'none';
    }else if(deferredPrompt){
      installText.textContent = 'Instalar este app na tela inicial, para acesso rápido e em tela cheia?';
      installConfirm.style.display = '';
    }else{
      installText.textContent = 'Abra o menu (⋮) do navegador e toque em "Instalar app" ou "Adicionar à tela inicial".';
      installConfirm.style.display = 'none';
    }
    installOverlay.classList.add('open');
  });

  installCancel.addEventListener('click', ()=> installOverlay.classList.remove('open')); 

  installConfirm.addEventListener('click', async ()=>{
    if(!deferredPrompt) return;
    installOverlay.classList.remove('open');
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.classList.add('hidden');
  });

  window.addEventListener('appinstalled', ()=> installBtn.classList.add('hidden'));

  // --- easter egg: 3 toques no "v1.0" ---
  const versionTag = document.getElementById('versionTag');
  const easterOverlay = document.getElementById('easterOverlay');
  const easterCredits = document.getElementById('easterCredits');
  const easterGame = document.getElementById('easterGame');
  let tapCount = 0, tapTimer = null;

  versionTag.addEventListener('click', ()=>{
    versionTag.classList.remove('wiggle');
    void versionTag.offsetWidth; // reinicia a animação
    versionTag.classList.add('wiggle');
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(()=> tapCount = 0, 1500);
    if(tapCount >= 3){
      tapCount = 0;
      easterCredits.style.display = '';
      easterGame.style.display = 'none';
      easterOverlay.classList.add('open');
    }
  });

  document.getElementById('easterClose').addEventListener('click', ()=> easterOverlay.classList.remove('open'));
  document.getElementById('easterGameClose').addEventListener('click', ()=>{
    easterOverlay.classList.remove('open');
    stopBallGame();
  });
  document.getElementById('easterPlay').addEventListener('click', ()=>{
    easterCredits.style.display = 'none';
    easterGame.style.display = '';
    startBallGame();
  });

  // --easter egg, parte feito com claudinho, pode ter bug
  document.getElementById('gameReplay').addEventListener('click', startBallGame);
  const BASE_GRAVITY = isMobile ? 0.03 : 0.07;
  const canvas = document.getElementById('ballCanvas');
  const gctx = canvas.getContext('2d');
  
  let ball, gameScoreVal = 0, gameOver = false, gameRAF = null;

 function startBallGame(){
    ball = { x:150, y:60, vy:0, vx:0, r:16 };
    gameScoreVal = 0; gameOver = false;
    document.getElementById('gameScore').textContent = 'Pontos: 0';
    document.getElementById('gameReplay').style.display = 'none';
    canvas.onpointerdown = hitBall;
    loopGame();
  }
  function stopBallGame(){
    cancelAnimationFrame(gameRAF);
    canvas.onpointerdown = null;
  }
   function hitBall(e){
    if(gameOver) return;
    const x = e.offsetX, y = e.offsetY;
    const hitRadius = ball.r + 18;
    const dx = x - ball.x, dy = y - ball.y;
    if(Math.sqrt(dx*dx + dy*dy) >= hitRadius) return;

    if(dy <= 0){
      ball.vy += 1.5; // tocou em cima: não sobe, cai mais rápido
      return;
    }

    const tx = dx / hitRadius; // -1 (esquerda) a 1 (direita)
    const absTx = Math.abs(tx);
    if(absTx < 0.3){
      ball.vx = -tx * 3;  // quase no centro: sobe reto
      ball.vy = -9;
    }else if(absTx < 0.65){
      ball.vx = -tx * 8;  // deslocado: desvia suave pro lado oposto
      ball.vy = -8;
    }else{
      ball.vx = tx * 22;  // lateral: sai rápido pro lado tocado
      ball.vy = -3;
    }

    gameScoreVal++;
    document.getElementById('gameScore').textContent = 'Pontos: '+gameScoreVal;
  }
  function loopGame(){
    gctx.clearRect(0,0,canvas.width,canvas.height);
    const difficulty = 1 + Math.floor(gameScoreVal/20)*0.15;
    ball.vy += BASE_GRAVITY * difficulty;
    ball.vx *= 0.995;
    ball.x += ball.vx;
    ball.y += ball.vy;
    if(ball.y - ball.r < 0){ ball.y = ball.r; ball.vy = 0; }

    const outBottom = ball.y - ball.r > canvas.height;
    const outSide = ball.x + ball.r < 0 || ball.x - ball.r > canvas.width;
    if(outBottom || outSide){
      gameOver = true;
      gctx.fillStyle = '#F3F1EA'; gctx.font = '14px Inter,sans-serif'; gctx.textAlign = 'center';
      gctx.fillText('Fim de jogo!', canvas.width/2, canvas.height/2);
      document.getElementById('gameReplay').style.display = '';
      return;
    }
    gctx.fillStyle = '#F2A93B';
    gctx.beginPath(); gctx.arc(ball.x, ball.y, ball.r, 0, Math.PI*2); gctx.fill();
    gameRAF = requestAnimationFrame(loopGame);
  }
})();
