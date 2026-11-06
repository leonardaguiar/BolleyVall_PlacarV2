(function(){
  const $ = id => document.getElementById(id);
  const mixed = $('mixed'), trio = $('trio'), fixed = $('fixed'), dynamic = $('dynamic');
  let lines = [];
  let currentPlan = null;   // dados estruturados do sorteio, usados pelo acompanhamento (fila.js)

  // ---------- interface ----------
  function syncUI(){
    $('boxAll').hidden = mixed.checked;
    $('boxMixed').hidden = !mixed.checked;
    fixed.disabled = dynamic.disabled = trio.checked;
    $('modeRow').classList.toggle('off', trio.checked);
  }
  // fixa/dinâmica se comportam como opção única
  fixed.addEventListener('change', ()=>{ dynamic.checked = !fixed.checked; });
  dynamic.addEventListener('change', ()=>{ fixed.checked = !dynamic.checked; });
  mixed.addEventListener('change', syncUI);
  trio.addEventListener('change', syncUI);
  syncUI();

  // ---------- utilitários ----------
  const parse = t => t.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean);
  function shuffle(a){
    a = a.slice();
    for(let i=a.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i],a[j]] = [a[j],a[i]];
    }
    return a;
  }
  function combos(n,k){
    const out = [];
    (function rec(s,cur){
      if(cur.length===k){ out.push(cur.slice()); return; }
      for(let i=s;i<n;i++){ cur.push(i); rec(i+1,cur); cur.pop(); }
    })(0,[]);
    return out;
  }
  function sig(str){
    let h = 5381;
    for(const c of str) h = ((h<<5)+h+c.charCodeAt(0))>>>0;
    return 'BVP-'+h.toString(16).toUpperCase().padStart(8,'0');
  }

  function getPlayers(){
    let list;
    if(mixed.checked){
      list = parse($('namesM').value).map(n=>({n,g:'M'}))
        .concat(parse($('namesF').value).map(n=>({n,g:'F'})));
    }else{
      list = parse($('namesAll').value).map(n=>({n,g:null}));
    }
    const seen = new Set();
    for(const p of list){
      const k = p.n.toLowerCase();
      if(seen.has(k)) throw new Error('Nome repetido: '+p.n+'. Use nomes diferentes (ex.: Ana S. e Ana M.).');
      seen.add(k);
    }
    return list;
  }

  // ---------- dupla fixa: monta as equipes uma vez e sorteia a fila ----------
  function formFixed(P,k,isMixed,cap){
    if(isMixed && cap){
      const men = shuffle(P.filter(p=>p.g==='M')), wom = shuffle(P.filter(p=>p.g==='F'));
      const plan = capPlan(men.length, wom.length, k, cap.N, cap.exact);
      if(plan.T < 2){
        throw new Error('Com máximo de '+cap.N+' homens por time ('+(cap.exact ? 'exato' : 'até o máximo')+') só dá para formar '+plan.T+' time(s). São necessários pelo menos 2: ajuste o limite.');
      }
      const teams = Array.from({length:plan.T}, ()=>[]);
      men.slice(0,plan.men).forEach((p,i)=> teams[i % plan.T].push(p));
      wom.slice(0,plan.women).forEach(p=>{
        let t = teams[0];
        for(const x of teams) if(x.length < t.length) t = x;
        t.push(p);
      });
      const reserve = [...men.slice(plan.men), ...wom.slice(plan.women)];
      return { teams: shuffle(teams), reserve };
    }
    let pool = shuffle(P);
    const r = pool.length % k;
    const reserve = r ? pool.splice(pool.length-r, r) : [];
    if(isMixed){
      pool = [...shuffle(pool.filter(p=>p.g==='M')), ...shuffle(pool.filter(p=>p.g==='F'))];
    }
    const T = pool.length / k;
    const teams = Array.from({length:T}, ()=>[]);
    pool.forEach((p,i)=> teams[i % T].push(p));
    return { teams: shuffle(teams), reserve };
  }

  // reservas viram "times": grupo completo só com pelo menos 1 mulher (no misto);
  // sem mulher, divide em grupos menores (no máximo k-1 por grupo)
  function groupReserve(res,k,isMixed){
    if(!isMixed){
      const out = [];
      for(let i=0;i<res.length;i+=k) out.push(res.slice(i,i+k));
      return out;
    }
    const M = res.filter(p=>p.g==='M'), F = res.filter(p=>p.g==='F'), out = [];
    while(F.length && M.length+F.length >= k){
      const g = [F.shift()];
      while(g.length < k) g.push((M.length >= F.length ? M : F).shift());
      out.push(g);
    }
    const rest = [...M, ...F];
    if(rest.length){
      if(F.length || rest.length < k) out.push(rest);
      else{
        const n = rest.length, c = Math.ceil(n/(k-1)), base = Math.floor(n/c), extra = n % c;
        let pos = 0;
        for(let i=0;i<c;i++){
          const sz = base + (i < extra ? 1 : 0);
          out.push(rest.slice(pos,pos+sz));
          pos += sz;
        }
      }
    }
    return out;
  }

   // ---------- dupla dinâmica: todas as duplas possíveis, em ordem de fila ----------
  // Prioridades: 1) ninguém repetido em jogos seguidos, 2) cada parceria aparece uma vez,
  // 3) mistas primeiro, 4) participação e espera equilibradas, 5) evitar repetir quem acabou de jogar.
   // dupla dinâmica sem rodadas: todas as duplas possíveis, em ordem de fila
  function genPairs(P,isMixed){
    const n = P.length;
    const rem = combos(n,2);
    const played = new Array(n).fill(0), rest = new Array(n).fill(0);
    const seq = [];
    while(rem.length){
      const recent = new Set();
      for(const t of seq.slice(-2)) t.forEach(i=>recent.add(i));
      let bi = 0, bs = Infinity;
      rem.forEach((c,idx)=>{
        let s = Math.random()*0.5;
        for(const i of c){
          if(recent.has(i)) s += 1e6;
          s += 10*played[i] - 3*rest[i];
        }
        if(isMixed && P[c[0]].g === P[c[1]].g) s += 1e3;
        if(s < bs){ bs = s; bi = idx; }
      });
      const c = rem.splice(bi,1)[0];
      seq.push(c);
      for(let i=0;i<n;i++){ if(c.includes(i)){ played[i]++; rest[i] = 0; } else rest[i]++; }
    }
    return seq.map(c=>c.map(i=>P[i]));
  }

    // dupla dinâmica: um jogo por rodada, sem fila (monta as duas duplas do confronto)
  // Prioridades: 1) ninguém repetido no jogo, 2) parcerias novas, 3) misto,
  // 4) participação e espera, 5) evitar repetir quem acabou de jogar.
  function genGames(P,R,isMixed){
    const n = P.length, total = n*(n-1)/2, limit = R || 80;
    const times = {}, played = new Array(n).fill(0), rest = new Array(n).fill(0);
    const prev = new Set(), all = combos(n,2), games = [];
    let covered = 0;

    const pick = banned=>{
      let best = null, bs = Infinity;
      for(const c of all){
        if(banned && c.some(i=>banned.has(i))) continue;
        let s = Math.random()*0.5;
        for(const i of c) s += 10*played[i] - 3*rest[i] + (prev.has(i) ? 2 : 0);
        s += 1e4*(times[pkey(c[0],c[1])]||0);
        if(isMixed && P[c[0]].g===P[c[1]].g) s += 1e3;
        if(s<bs){ bs = s; best = c; }
      }
      return best;
    };

    while(games.length < limit && (R || covered < total)){
      const X = pick(null), Y = pick(new Set(X));
      games.push([X,Y]);
      const on = new Set([...X,...Y]);
      for(const T of [X,Y]){
        const key = pkey(T[0],T[1]);
        if(!times[key]) covered++;
        times[key] = (times[key]||0)+1;
      }
      for(let i=0;i<n;i++){ if(on.has(i)){ played[i]++; rest[i] = 0; } else rest[i]++; }
      prev.clear(); on.forEach(i=>prev.add(i));
    }
    return {
      games: games.map(([X,Y])=>[X.map(i=>P[i]), Y.map(i=>P[i])]),
      complete: covered >= total
    };
  }

  // ---------- rodadas ----------
  const pkey = (a,b)=> a<b ? a+'|'+b : b+'|'+a;

  // dupla fixa e trio: equipes novas a cada rodada, evitando repetir parceiros
  // e dando prioridade a quem ficou de fora na rodada anterior
   function formRound(P,k,isMixed,hist,cap){
    let best = null, bs = Infinity;
    for(let t=0;t<300;t++){
      const f = formFixed(P,k,isMixed,cap);
      let s = Math.random()*0.5;
      for(const team of f.teams)
        for(let x=0;x<k;x++) for(let y=x+1;y<k;y++)
          if(hist.pairs.has(pkey(team[x].n,team[y].n))) s += 10;
      for(const p of f.reserve) s += 20*(hist.sat[p.n]||0);
      if(s<bs){ bs = s; best = f; }
    }
    best.teams.forEach(team=>{
      for(let x=0;x<k;x++) for(let y=x+1;y<k;y++) hist.pairs.add(pkey(team[x].n,team[y].n));
    });
    best.reserve.forEach(p=>{ hist.sat[p.n] = (hist.sat[p.n]||0)+1; });
    return best;
  }

  // dupla dinâmica por rodadas: monta as duplas e os confrontos, jogo a jogo
  function genRounds(P,R,isMixed){
    const n = P.length, games = Math.floor(n/4);
    const times = {}, played = new Array(n).fill(0), rest = new Array(n).fill(0);
    const all = combos(n,2), rounds = [];
    for(let r=0;r<R;r++){
      const used = new Set(), list = [];
      const pick = banned=>{
        let best = null, bs = Infinity;
        for(const c of all){
          if(c.some(i=>banned.has(i))) continue;               // 1: ninguém repetido no jogo
          let s = Math.random()*0.5;
          for(const i of c) s += 10*played[i] - 3*rest[i];     // 4: participação e espera
          s += 1e4*(times[pkey(c[0],c[1])]||0);                // 2: parcerias novas
          if(isMixed && P[c[0]].g===P[c[1]].g) s += 1e3;       // 3: misto
          if(s<bs){ bs = s; best = c; }
        }
        return best;
      };
      for(let g=0;g<games;g++){
        const X = pick(used); X.forEach(i=>used.add(i));
        const Y = pick(used); Y.forEach(i=>used.add(i));
        list.push([X,Y]);
        for(const T of [X,Y]) times[pkey(T[0],T[1])] = (times[pkey(T[0],T[1])]||0)+1;
      }
      for(let i=0;i<n;i++){ if(used.has(i)){ played[i]++; rest[i] = 0; } else rest[i]++; }
      rounds.push({
        list: list.map(([X,Y])=>[X.map(i=>P[i]), Y.map(i=>P[i])]),
        out: P.filter((_,i)=>!used.has(i))
      });
    }
    return rounds;
  }

  function capPlan(m,f,k,N,exact){
    if(exact){
      const T = Math.min(N>0 ? Math.floor(m/N) : Infinity, k-N>0 ? Math.floor(f/(k-N)) : Infinity);
      return { T, men: T*N, women: T*(k-N) };
    }
    let T = Math.floor((m+f)/k);
    while(T>0 && T*k - Math.min(m,N*T) > f) T--;
    const men = Math.min(m,N*T);
    return { T, men, women: T*k - men };
  }
  function resolvePlan(m,f,k,N,exact){
    const plan = capPlan(m,f,k,N,exact);
    if(plan.T >= 2) return { plan, N, exact, relaxed:false };
    for(let d=1; d<=k; d++){
      let best = null;
      for(const n2 of [N+d, N-d]){
        if(n2 < 0 || n2 > k) continue;
        const p = capPlan(m,f,k,n2,exact);
        if(p.T >= 2 && (!best || p.T > best.plan.T)) best = { plan:p, N:n2, exact, relaxed:true };
      }
      if(best) return best;
    }
    if(exact){
      const r = resolvePlan(m,f,k,N,false);   // "Exato" impossível: cai para "Até o máximo"
      r.relaxed = true;
      return r;
    }
    return { plan, N, exact, relaxed:false };
  }

  // ---------- resultado ----------
  function build(){
    const P = getPlayers();
    const isTrio = trio.checked, k = isTrio ? 3 : 2;
    const isFixed = isTrio || fixed.checked, isMixed = mixed.checked;
    const unit = isTrio ? 'Trio' : 'Dupla';
    const nomes = time => time.map(p => p.n);
    const plano = { unit: unit, tamanho: k, fases: [] };

    // trio: os reservas entram no fim da fila como times incompletos
    const timesDaFila = sorteio => {
      const times = sorteio.teams.map(nomes);
      if (isTrio) {
        groupReserve(sorteio.reserve, k, isMixed).forEach(grupo => times.push(nomes(grupo)));
      }
      return times;
    };

    const rv = $('rounds').value.trim(), R = rv ? parseInt(rv,10) : 0;
    const mraw = $('maxM').value.trim();
    let cap = null, capNote = '';
    if(isMixed && isFixed && mraw !== ''){
      const N0 = Math.min(k, Math.max(0, parseInt(mraw,10) || 0));
      const ex0 = $('maxMode').value === 'exato';
      const m = P.filter(p=>p.g==='M').length, f = P.length - m;
      const r = resolvePlan(m,f,k,N0,ex0);
      cap = { N: r.N, exact: r.exact };
      if(r.relaxed) capNote = 'Com essa proporção de homens e mulheres não dá para respeitar o limite de '+N0+(ex0 ? ' (exato)' : '')+' homens por time; foi usado '+r.N+(r.exact ? ' (exato)' : ' (até o máximo)')+'.';
    }

    if(isNaN(R) || R < 0 || R > 30) throw new Error('Rodadas: informe um número de 1 a 30 (ou deixe vazio).');
    if(isMixed && (!P.some(p=>p.g==='M') || !P.some(p=>p.g==='F'))){
      throw new Error('No sorteio misto, informe homens e mulheres (ou desmarque "Priorizar misto").');
    }
    if(P.length < 2*k){
      throw new Error('Informe pelo menos '+(2*k)+' jogadores para sortear '+(isTrio ? 'trios' : 'duplas')+'.');
    }

    const nm = t => t.map(p=>p.n).join(' + ');
    const VS = '\u00A0'.repeat(10)+'vs.';
    const modo = isTrio ? 'Trio (fixo)' : fixed.checked ? 'Dupla fixa' : 'Dupla dinâmica';
    const L = [
      ['title','Sorteio de times'],
      ['m','Filtros: '+modo+' | Priorizar misto: '+(isMixed ? 'sim' : 'não')+' | '+P.length+' jogadores'+(R ? ' | Rodadas: '+R : '') +(cap ? ' | Máx. de homens por time: '+cap.N+(cap.exact ? ' (exato)' : ' (até o máximo)') : '')]
    ];

    if(capNote) L.push(['m',capNote]);

    const addGame = (A,B,u)=> L.push(['t',u+' 1: '+nm(A)], ['t',VS], ['t',u+' 2: '+nm(B)]);
    const addFixed = f=>{
      const { teams, reserve } = f;
      L.push(['h','JOGO 1']);
      addGame(teams[0],teams[1],unit);
      if(teams.length > 2){
        L.push(['h','FILA (ordem de entrada)']);
        teams.slice(2).forEach((t,i)=> L.push(['t',(i+1)+'º - '+unit+' '+(i+3)+': '+nm(t)]));
      }
      if(reserve.length){
        L.push(['h','RESERVAS']);
        groupReserve(reserve,k,isMixed).forEach((g,i)=>
          L.push(['t',unit+' '+(teams.length+i+1)+': '+nm(g)]));
      }
    };

    if(isFixed){
      if(R){
        const hist = { pairs: new Set(), sat: {} };
        for(let r=1;r<=R;r++){
          L.push(['h','=== RODADA '+r+' ===']);
          const sorteio = formRound(P,k,isMixed,hist,cap);
          addFixed(sorteio);
          plano.fases.push({ titulo: 'Rodada '+r, modo: 'fila', times: timesDaFila(sorteio)});
        }
      }else{
        const sorteio = formFixed(P,k,isMixed,cap);
        addFixed(sorteio);
        plano.fases.push({ titulo: 'Sorteio', modo: 'fila', times: timesDaFila(sorteio) });
      }
      L.push(['m','O vencedor enfrenta o próximo da fila.']);
    }else if(R){
      const { games } = genGames(P,R,isMixed);
      games.forEach(([A,B],i)=>{
        L.push(['h','=== RODADA '+(i+1)+' ===']);
        addGame(A,B,'Dupla');
        plano.fases.push({ titulo: 'Rodada '+(i+1), modo: 'jogo', times: [nomes(A), nomes(B)] });
      });
    }else{
      const seq = genPairs(P,isMixed);
      plano.fases.push({ titulo: 'Sorteio', modo: 'fila', times: seq.map(nomes) });
      L.push(['h','JOGO 1']);
      addGame(seq[0],seq[1],'Dupla');
      if(seq.length > 2){
        L.push(['h','FILA (ordem de entrada)']);
        seq.slice(2).forEach((t,i)=> L.push(['t',(i+1)+'º - Dupla '+(i+3)+': '+nm(t)]));
      }
      L.push(['m',seq.length+' duplas possíveis: todos jogam com todos. O vencedor enfrenta a próxima dupla da fila.']);
    }

    const body = L.map(x=>x[1]).join('|');
    L.push(['sig','Sorteio gerado pelo app BolleyVall Placar em '+new Date().toLocaleString('pt-BR')+' | Assinatura '+sig(body)]);
    currentPlan = plano;
    return L;
  }

  const toText = L => L.map(([t,s])=>(t==='h' ? '\n' : '')+s).join('\n').replace(/\n{3,}/g,'\n\n');

    // mostra a lista pura do sorteio (a mesma usada em Copiar e PDF)
   // mostra a lista pura do sorteio; "aberto" define se o bloco aparece expandido
  function mostrarResultado(aberto){
    $('err').hidden = true;
    $('resultText').textContent = toText(lines);
    $('result').hidden = false;
    $('result').open = aberto;
  }

  $('go').addEventListener('click', ()=>{
    try{
      if(Fila.temProgresso() && !confirm('Sortear de novo apaga o acompanhamento atual (fila e resultados). Continuar?')){
        return;
      }
      lines = build();
      Fila.iniciar(currentPlan, lines, lerFormulario());
      Compartilhar.prepararLink();
      $('avisoRecebido').hidden = true;
      mostrarResultado();
      $('tracker').scrollIntoView({behavior:'smooth'});
    }catch(e){
      $('err').textContent = e.message;
      $('err').hidden = false;
    }
  });

  // ---------- copiar ----------
  $('copyBtn').addEventListener('click', async ()=>{
    const txt = toText(lines), btn = $('copyBtn');
    try{ await navigator.clipboard.writeText(txt); }
    catch(e){
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    btn.textContent = 'Copiado!';
    setTimeout(()=> btn.textContent = 'Copiar', 1500);
  });

  // ---------- PDF ----------
  $('pdfBtn').addEventListener('click', ()=>{
    if(!window.jspdf){ alert('Não foi possível carregar a biblioteca de PDF. Verifique a conexão e tente de novo.'); return; }
    const doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    const x = 18, W = 174;
    let y = 20;
    const need = h => { if(y+h > 282){ doc.addPage(); y = 20; } };

    lines.forEach(([t,s])=>{
      if(t==='title'){
        doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.setTextColor(0);
        need(10); doc.text(s,x,y); y += 10;
      }else if(t==='h'){
        y += 3;
        doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(0);
        need(8); doc.text(s,x,y); y += 7;
      }else{
        const meta = (t==='m' || t==='sig');
        doc.setFont('helvetica', t==='sig' ? 'italic' : 'normal');
        doc.setFontSize(meta ? 9 : 11);
        doc.setTextColor(meta ? 110 : 0);
        if(t==='sig'){ y += 6; need(10); doc.setDrawColor(180); doc.line(x,y-4,x+W,y-4); }
        const rows = doc.splitTextToSize(s, W);
        rows.forEach(r=>{ need(6); doc.text(r,x,y); y += meta ? 5 : 6; });
      }
    });
    doc.save('sorteio-bolleyvall.pdf');
  });
    // ---------- limite de homens por time: sugestão automática e aviso ----------
  let maxTouched = false;
  function updateMaxUI(){
    const show = mixed.checked && (trio.checked || fixed.checked);
    $('maxBox').hidden = !show;
    if(!show) return;
    const k = trio.checked ? 3 : 2;
    const m = parse($('namesM').value).length, f = parse($('namesF').value).length;
    const mx = $('maxM');
    mx.max = k;
    if(!maxTouched) mx.value = (m+f) ? Math.ceil(k*m/(m+f)) : '';
    const hint = $('maxHint'), raw = mx.value.trim();
    if(raw === ''){ hint.textContent = 'Sem limite de homens por time.'; return; }
     const N0 = Math.min(k, Math.max(0, parseInt(raw,10) || 0));
    const r = resolvePlan(m,f,k,N0,$('maxMode').value === 'exato');
    const out = (m+f) - r.plan.T*k;
    let txt = r.plan.T < 2
      ? 'Com esses valores não dá para formar 2 times.'
      : 'Serão '+r.plan.T+' times'+(out ? ' e '+out+' jogador(es) ficam de fora.' : '.');
    if(r.relaxed) txt = 'Com essa proporção não dá para respeitar o limite informado: será usado '+r.N+' homem(ns) por time'+(r.exact ? ' (exato)' : ' (até o máximo)')+'. '+txt;
    hint.textContent = txt;
  }
  ['namesM','namesF'].forEach(id=> $(id).addEventListener('input', updateMaxUI));
  $('maxM').addEventListener('input', ()=>{ maxTouched = true; updateMaxUI(); });
  $('maxMode').addEventListener('change', updateMaxUI);
  [mixed,trio,fixed,dynamic].forEach(el=> el.addEventListener('change', updateMaxUI));
  updateMaxUI();

    // guarda o que está preenchido na tela (vai junto do sorteio, no link e no salvamento)
  function lerFormulario(){
    return {
      misto: mixed.checked,
      trio: trio.checked,
      fixa: fixed.checked,
      rodadas: $('rounds').value,
      maxHomens: $('maxM').value,
      regraMax: $('maxMode').value,
      todos: $('namesAll').value,
      homens: $('namesM').value,
      mulheres: $('namesF').value
    };
  }

  // preenche a tela com o formulário de um sorteio recebido ou reaberto
  function aplicarFormulario(formulario){
    if(!formulario) return;
    mixed.checked = formulario.misto;
    trio.checked = formulario.trio;
    fixed.checked = formulario.fixa;
    dynamic.checked = !formulario.fixa;
    $('rounds').value = formulario.rodadas;
    $('namesAll').value = formulario.todos;
    $('namesM').value = formulario.homens;
    $('namesF').value = formulario.mulheres;
    $('maxMode').value = formulario.regraMax;
    $('maxM').value = formulario.maxHomens;
    maxTouched = true;      // mantém o limite que veio, sem recalcular a sugestão
    syncUI();
    updateMaxUI();
  }

  // reabre o último sorteio salvo no aparelho
   // botão "Compartilhar sorteio"
  $('shareBtn').addEventListener('click', ()=> Compartilhar.compartilhar($('shareBtn')));

  // ao abrir a página: sorteio recebido por link ou último sorteio salvo no aparelho
   // ao abrir a página: sorteio recebido por link ou último sorteio salvo no aparelho
   // aviso azul no topo (sorteio recebido, andamento recebido)
  function mostrarAviso(texto){
    $('avisoRecebido').textContent = texto;
    $('avisoRecebido').hidden = false;
  }

  function horaDoAndamento(andamento){
    return new Date(andamento.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  // aplica um andamento recebido; se este aparelho já tem jogos, pergunta antes de substituir
  function aplicarAndamentoRecebido(recebido){
    const jogosNoLink = recebido.andamento.estado.historico.length;
    const jogosAqui = Fila.quantidadeDeJogos();
    const hora = horaDoAndamento(recebido.andamento);

    if(jogosAqui > 0){
      const mensagem = 'Este aparelho tem ' + jogosAqui + ' jogo(s) registrado(s). '
        + 'O andamento do link (gerado às ' + hora + ') tem ' + jogosNoLink + '. '
        + 'Usar o do link e substituir o seu?';
      if(!confirm(mensagem)) return;
    }

    lines = recebido.linhas;
    Fila.iniciarComAndamento(recebido.plano, recebido.linhas, recebido.formulario, recebido.andamento);
    aplicarFormulario(recebido.formulario);
    mostrarResultado(false);
    mostrarAviso('Andamento recebido (' + jogosNoLink + ' jogo(s), gerado às ' + hora + '). Você pode continuar daqui.');
    Compartilhar.prepararLink();
  }

  // aplica um sorteio recebido (sem andamento); se houver jogos registrados, pergunta antes
  function aplicarSorteioRecebido(recebido){
    const podeSubstituir = !Fila.temProgresso()
      || confirm('Você recebeu um sorteio novo. Isso substitui o acompanhamento atual deste aparelho. Continuar?');
    if(!podeSubstituir) return;

    lines = recebido.linhas;
    Fila.iniciar(recebido.plano, recebido.linhas, recebido.formulario);
    aplicarFormulario(recebido.formulario);
    mostrarResultado(false);
    mostrarAviso('Sorteio recebido por link. O acompanhamento começa do zero neste aparelho.');
    Compartilhar.prepararLink();
  }

  // ao abrir a página: sorteio/andamento recebido por link, ou último sorteio salvo no aparelho
  async function abrirSorteioInicial(){
    let recebido = null;
    try{
      recebido = await Compartilhar.lerDoLink();
    }catch(e){
      $('err').textContent = 'Este link está incompleto ou inválido.';
      $('err').hidden = false;
    }

    // primeiro reabre o que já estava salvo neste aparelho
    const salvo = Fila.carregar();
    if(salvo){
      lines = salvo.linhas;
      aplicarFormulario(salvo.formulario);
      Fila.processarPedidoPendente();
      mostrarResultado(false);
      Compartilhar.prepararLink();
    }
    if(!recebido) return;

    if(recebido.andamento){
      aplicarAndamentoRecebido(recebido);
    }else{
      aplicarSorteioRecebido(recebido);
    }
    Compartilhar.limparLinkDaBarra();
  }
  abrirSorteioInicial();
  
})();
