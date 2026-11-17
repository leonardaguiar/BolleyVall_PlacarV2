(function(){
  const $ = id => document.getElementById(id);
  const mixed = $('mixed'), trio = $('trio'), fixed = $('fixed'), dynamic = $('dynamic'), dynamicModel2 = $('dynamicModel2');
  const winnerStays = $('winnerStays');
  let lines = [];
  let currentPlan = null;   // dados estruturados do sorteio, usados pelo acompanhamento (fila.js)
  let sharedViewerContext = null;
  let sharedViewerPoll = null;
  let sharedViewerRequestActive = false;

  // ---------- interface ----------
  function syncUI(){
    $('boxAll').hidden = mixed.checked;
    $('boxMixed').hidden = !mixed.checked;
    fixed.disabled = dynamic.disabled = dynamicModel2.disabled = trio.checked;
    $('modeRow').classList.toggle('off', trio.checked);
    $('trioModeBox').hidden = !trio.checked;
    const modoTrio = document.querySelector('input[name="trioMode"]:checked').value;
    const rotativo = trio.checked && modoTrio !== 'fixed';
    const modelo2 = trio.checked ? modoTrio === 'rotativo-modelo2' : dynamicModel2.checked;
    $('rounds').disabled = rotativo || modelo2;
    $('rounds').parentElement.classList.toggle('off', rotativo || modelo2);
    $('stayRow').hidden = !rotativo;
    atualizarPessoasEControles();
  }
  function atualizarModeloDupla(){
    if(dynamicModel2.checked){fixed.checked=false;dynamic.checked=false;}
    else if(!fixed.checked&&!dynamic.checked) dynamic.checked=true;
    syncUI();
  }
  // fixa/dinâmica se comportam como opção única
  fixed.addEventListener('change', ()=>{ dynamic.checked = !fixed.checked; dynamicModel2.checked=false; syncUI(); });
  dynamic.addEventListener('change', ()=>{ fixed.checked = !dynamic.checked; dynamicModel2.checked=false; syncUI(); });
  dynamicModel2.addEventListener('change', atualizarModeloDupla);
  mixed.addEventListener('change', syncUI);
  trio.addEventListener('change', syncUI);
  document.querySelectorAll('input[name="trioMode"]').forEach(el=>el.addEventListener('change', syncUI));
  ['namesAll','namesM','namesF'].forEach(id=>$(id).addEventListener('input', atualizarPessoasEControles));
  syncUI();

  function lerQuantidadeJogadores(){
    return mixed.checked
      ? parse($('namesM').value).length + parse($('namesF').value).length
      : parse($('namesAll').value).length;
  }
  function atualizarPessoasEControles(){
    const modoTrio = document.querySelector('input[name="trioMode"]:checked').value;
    const rotativo = trio.checked && modoTrio !== 'fixed';
    const modelo2 = trio.checked ? modoTrio === 'rotativo-modelo2' : dynamicModel2.checked;
    const n = lerQuantidadeJogadores();
    const somenteSeis = rotativo && n === 6;
    const estavaDesativado=winnerStays.disabled;
    winnerStays.disabled = somenteSeis;
    if(somenteSeis) winnerStays.checked=false;
    else if(estavaDesativado) winnerStays.checked=true;
    $('stayHint').hidden = !somenteSeis;
    const info = $('comboCount');
    if((rotativo || modelo2) && n >= (trio.checked?3:2)){
      const k=trio.checked?3:2;
      const total = k===3 ? n*(n-1)*(n-2)/6 : n*(n-1)/2;
      const unidade=k===3?'trios':'duplas';
      info.textContent = total.toLocaleString('pt-BR')+' '+unidade+' possíveis'+(modelo2 ? (total>2000?'; o Modelo 2 permite até 2.000 composições.':'; a fila do Modelo 2 é formada durante os jogos.') : k===3&&n%3 ? '; as próximas equipes serão sorteadas durante os jogos.' : '.');
      info.hidden = false;
    }else info.hidden = true;
  }

  // ---------- utilitários ----------
  function parse(t){ return t.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean); }
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

  function gerarCombinacoesModelo2(P,k,cap){
    return combos(P.length,k).map(indices=>indices.map(i=>P[i])).filter(time=>{
      if(k!==3||!cap) return true;
      const homens=time.filter(p=>p.g==='M').length;
      return cap.exact?homens===cap.N:homens<=cap.N;
    });
  }
  const chaveTime = time => time.map(p=>p.n.toLocaleLowerCase('pt-BR')).sort().join('|');
  const timeMisto = time => time.some(p=>p.g==='M')&&time.some(p=>p.g==='F');
  function selecionarTimesSemSobreposicao(opcoes,quantas,k,misto){
    const candidatos=shuffle(opcoes);
    if(quantas===1){
      candidatos.sort((a,b)=>Number(timeMisto(b))-Number(timeMisto(a)));
      return candidatos.length?[candidatos[0]]:[];
    }
    let melhor=null,melhorScore=-Infinity;
    for(let i=0;i<candidatos.length;i++){
      const nomes=new Set(candidatos[i].map(p=>p.n.toLocaleLowerCase('pt-BR')));
      for(let j=i+1;j<candidatos.length;j++){
        if(candidatos[j].some(p=>nomes.has(p.n.toLocaleLowerCase('pt-BR')))) continue;
        const score=(misto?(Number(timeMisto(candidatos[i]))+Number(timeMisto(candidatos[j])))*100000:0)+Math.random();
        if(score>melhorScore){melhorScore=score;melhor=[candidatos[i],candidatos[j]];}
      }
    }
    return melhor||[];
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

  function quantidadeCombinacoes(n,k){
    if(n<k) return 0;
    let v=1;
    for(let i=1;i<=k;i++) v=v*(n-k+i)/i;
    return Math.round(v);
  }

  function trioDentroDaRegra(trioPessoas,cap){
    if(!cap) return true;
    const homens=trioPessoas.filter(p=>p.g==='M').length;
    return cap.exact ? homens===cap.N : homens<=cap.N;
  }

  function genRotatingTrios(P,isMixed,cap,permanencia){
    const total=quantidadeCombinacoes(P.length,3);
    if(P.length%3===0){
      if(total>2000) throw new Error('Este sorteio teria '+total.toLocaleString('pt-BR')+' combinações de trio. O limite para gerar a fila completa é 2.000.');
      let equipes=combos(P.length,3).map(indices=>indices.map(i=>P[i])).filter(t=>trioDentroDaRegra(t,cap));
      if(equipes.length<2) throw new Error('As regras de misto escolhidas não permitem formar dois trios diferentes. Ajuste o limite de homens por time.');
      if(isMixed){
        const mistas=shuffle(equipes.filter(t=>new Set(t.map(p=>p.g)).size>1));
        const naoMistas=shuffle(equipes.filter(t=>new Set(t.map(p=>p.g)).size===1));
        equipes=[...mistas,...naoMistas];
      }else equipes=shuffle(equipes);
      let primeiro=-1,segundo=-1;
      for(let i=0;i<equipes.length&&primeiro<0;i++){
        const usados=new Set(equipes[i].map(p=>p.n));
        const candidatos=[];
        for(let j=i+1;j<equipes.length;j++) if(equipes[j].every(p=>!usados.has(p.n))) candidatos.push(j);
        if(candidatos.length){ primeiro=i; segundo=candidatos[Math.floor(Math.random()*candidatos.length)]; }
      }
      if(primeiro<0) throw new Error('Não foi possível montar dois trios sem jogadores repetidos. Ajuste a regra de homens por time.');
      const ordem=[equipes[primeiro],equipes[segundo],...equipes.filter((_,i)=>i!==primeiro&&i!==segundo)];
      return {
        modo:'completo',
        times:ordem.map(t=>t.map(p=>p.n)),
        total:equipes.length,
        metadata:{ jogadores:P.map(p=>({n:p.n,g:p.g})), misto:isMixed, cap:cap, permanencia:permanencia, combinacoesCompletas:true }
      };
    }

    // Com reservas, só o primeiro jogo é montado agora. As próximas equipes
    // serão escolhidas na hora, usando quem está há mais tempo fora da quadra.
    const inicial=formFixed(P,3,isMixed,cap);
    if(inicial.teams.length<2) throw new Error('Informe pelo menos 6 jogadores para formar dois trios completos.');
    return {
      modo:'reservas',
      times:inicial.teams.slice(0,2).map(t=>t.map(p=>p.n)),
      total:total,
      metadata:{ jogadores:P.map(p=>({n:p.n,g:p.g})), misto:isMixed, cap:cap, permanencia:permanencia, combinacoesCompletas:false }
    };
  }

  function listarFilaRotativa(times,comInicio){
    const L=[];
    const inicio=comInicio ? 2 : 0;
    for(let i=inicio;i<times.length;i++) L.push(['q','Trio '+(i+1)+': '+times[i].join(' + ')]);
    return L;
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
    const modoTrio = document.querySelector('input[name="trioMode"]:checked').value;
    const isRotativo = isTrio && modoTrio !== 'fixed';
    const isModelo2 = isTrio ? modoTrio === 'rotativo-modelo2' : dynamicModel2.checked;
    const isFixed = isTrio ? !isRotativo : fixed.checked, isMixed = mixed.checked;
    const unit = isTrio ? 'Trio' : 'Dupla';
    const nomes = time => time.map(p => p.n);
    const plano = { unit: unit, tamanho: k, fases: [], participantes: P.map(p=>({n:p.n,g:p.g})) };

    // trio: os reservas entram no fim da fila como times incompletos
    const timesDaFila = sorteio => {
      const times = sorteio.teams.map(nomes);
      if (isTrio) {
        groupReserve(sorteio.reserve, k, isMixed).forEach(grupo => times.push(nomes(grupo)));
      }
      return times;
    };

    const rv = $('rounds').value.trim(), R = isRotativo || isModelo2 ? 0 : (rv ? parseInt(rv,10) : 0);
    const mraw = $('maxM').value.trim();
    let cap = null, capNote = '';
    if(isMixed && (isFixed || isRotativo) && mraw !== ''){
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
    if(isModelo2){
      const total=k===3?P.length*(P.length-1)*(P.length-2)/6:P.length*(P.length-1)/2;
      if(total>2000) throw new Error('O Modelo 2 permite até 2.000 composições possíveis. Reduza a quantidade de jogadores para continuar.');
    }
    plano.configuracao={
      tipo:isModelo2?(isTrio?'trio-rotativo-modelo2':'dupla-dinamica-modelo2'):isRotativo?'trio-rotativo':isTrio?'trio-fixo':fixed.checked?'dupla-fixa':R?'dupla-rodadas':'dupla-dinamica',
      tipoTrioOriginal:isRotativo?(isModelo2?'trio-rotativo-modelo2':'trio-rotativo'):isTrio?'trio-fixo':null,
      misto:isMixed, cap:cap, permanencia:isRotativo?(P.length===6?false:winnerStays.checked):(isModelo2&&!isTrio),
      rodadas:R, tamanho:k
    };

    const nm = t => t.map(p=>typeof p==='string' ? p : p.n).join(' + ');
    const VS = '\u00A0'.repeat(10)+'vs.';
    const modo = isModelo2 ? (isTrio?'Trio rotativo Modelo 2':'Dupla dinâmica Modelo 2') : isRotativo ? 'Trio rotativo' : isTrio ? 'Trio (fixo)' : fixed.checked ? 'Dupla fixa' : 'Dupla dinâmica';
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

    if(isModelo2){
      const todas=gerarCombinacoesModelo2(P,k,cap);
      if(todas.length<2) throw new Error('Com os filtros atuais não é possível formar duas '+(k===3?'equipes de trio':'duplas')+'. Ajuste o limite de homens por time.');
      const iniciais=selecionarTimesSemSobreposicao(todas,2,k,isMixed);
      if(iniciais.length<2) throw new Error('Não foi possível formar duas equipes sem jogadores repetidos. Ajuste os filtros ou a quantidade de jogadores.');
      const emQuadra=new Set(iniciais.flatMap(t=>t.map(p=>p.n.toLocaleLowerCase('pt-BR'))));
      const fora=todas.filter(t=>t.every(p=>!emQuadra.has(p.n.toLocaleLowerCase('pt-BR'))));
      const preparadas=selecionarTimesSemSobreposicao(fora,Math.min(2,Math.floor(P.filter(p=>!emQuadra.has(p.n.toLocaleLowerCase('pt-BR'))).length/k)),k,isMixed);
      const nomesIniciais=iniciais.map(nomes), nomesPreparados=preparadas.map(nomes);
      const restantes=todas.filter(t=>!new Set(iniciais.map(chaveTime)).has(chaveTime(t)));
      const listaCompartilhada=[...iniciais,...shuffle(restantes)].map(nomes);
      const total=k===3?P.length*(P.length-1)*(P.length-2)/6:P.length*(P.length-1)/2;
      const permanencia=isTrio?(P.length===6?false:winnerStays.checked):true;
      const fase={
        titulo:'Sorteio',modo:'fila',times:[...nomesIniciais,...nomesPreparados],dinamico:true,
        preparados:nomesPreparados.map((_,i)=>i+2),
        modelo2:{tamanho:k,jogadores:P.map(p=>({...p})),misto:isMixed,cap:cap,permanencia:permanencia,totalCombinacoes:total,combinacoesCompartilhadas:listaCompartilhada,usadas:[...iniciais,...preparadas].map(chaveTime)}
      };
      plano.fases.push(fase);
      L.push(['h','JOGO 1']);
      addGame(iniciais[0],iniciais[1],unit);
      L.push(['model2-header','COMBINAÇÕES POSSÍVEIS (ordem de referência; a fila do app é montada durante os jogos)']);
      listaCompartilhada.forEach((time,i)=>L.push(['q',unit+' '+(i+1)+': '+nm(time)]));
      L.push(['m',total.toLocaleString('pt-BR')+' combinações possíveis. A fila do acompanhamento prioriza quem está há mais tempo sem jogar e tenta evitar repetir formações ainda não usadas.']);
      if(nomesPreparados.length===1) L.push(['m','Uma equipe futura foi preparada; o adversário será definido quando a partida atual terminar.']);
      else if(nomesPreparados.length===0) L.push(['m','As próximas equipes serão definidas quando a partida atual terminar.']);
      if(isTrio) L.push(['m',permanencia?'O trio vencedor permanece por mais uma partida e depois sai da quadra.':'O trio vencedor sai da quadra após a partida.']);
      else L.push(['m','A dupla vencedora permanece por mais uma partida e depois sai da quadra.']);
    }else if(isRotativo){
      const permanencia = P.length===6 ? false : winnerStays.checked;
      const sorteio=genRotatingTrios(P,isMixed,cap,permanencia);
      const fase={
        titulo:'Sorteio', modo:'fila', times:sorteio.times, dinamico:true,
        rotativo:{modo:sorteio.modo,jogadores:sorteio.metadata.jogadores,misto:sorteio.metadata.misto,cap:sorteio.metadata.cap,permanencia:sorteio.metadata.permanencia,combinacoesCompletas:sorteio.metadata.combinacoesCompletas,totalCombinacoes:sorteio.total}
      };
      plano.fases.push(fase);
      L.push(['h','JOGO 1']);
      addGame(sorteio.times[0],sorteio.times[1],unit);
      if(sorteio.modo==='completo'){
        L.push(['h','FILA (trios possíveis)']);
        L.push(...listarFilaRotativa(sorteio.times,true));
        L.push(['m',sorteio.total.toLocaleString('pt-BR')+' combinações de trio. Cada trio aparece pelo menos uma vez; repetições podem ocorrer pela fila e pela permanência do vencedor.']);
      }else{
        const emQuadra=new Set([...sorteio.times[0],...sorteio.times[1]]);
        const reservas=P.filter(p=>!emQuadra.has(p.n)).map(p=>p.n);
        if(reservas.length) L.push(['h','RESERVAS (entram conforme o tempo de espera)'],['t',reservas.join(' + ')]);
        L.push(['m',sorteio.total.toLocaleString('pt-BR')+' trios possíveis em teoria. As próximas equipes serão sorteadas durante os jogos.']);
      }
      if(P.length===6) L.push(['m','Com 6 jogadores, o vencedor sai após cada jogo para permitir a rotação.']);
      else L.push(['m',permanencia ? 'O trio vencedor permanece por mais uma partida e depois sai da quadra.' : 'O trio vencedor sai da quadra após a partida.']);
    }else if(isFixed){
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
      plano.fases.push({ titulo: 'Sorteio', modo: 'fila', times: seq.map(nomes), dinamico:true });
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

  let resultObserver = null, quantidadeFilaExibida = 0;
  function renderizarResultadoProgressivo(){
    const filas=lines.filter(([tipo])=>tipo==='q').length;
    const maxFila=quantidadeFilaExibida;
    let exibidas=0;
    const parte=lines.filter(([tipo])=>{
      if(tipo!=='q') return true;
      if(exibidas>=maxFila) return false;
      exibidas++;
      return true;
    });
    $('resultText').textContent=toText(parte);
    const restante=filas-exibidas;
    $('resultMore').hidden=restante<=0;
    $('resultMore').textContent=restante>0 ? 'Role até o fim para carregar mais composições ('+restante.toLocaleString('pt-BR')+' restantes).' : '';
  }

    // mostra a lista pura do sorteio (a mesma usada em Copiar e PDF)
   // mostra a lista pura do sorteio; "aberto" define se o bloco aparece expandido
  function mostrarResultado(aberto){
    $('err').hidden = true;
    if(resultObserver){ resultObserver.disconnect(); resultObserver=null; }
    const totalFila=lines.filter(([tipo])=>tipo==='q').length;
    quantidadeFilaExibida=Math.min(totalFila,20);
    renderizarResultadoProgressivo();
    $('result').hidden = false;
    $('result').open = aberto;
    if(totalFila>20 && 'IntersectionObserver' in window){
      resultObserver=new IntersectionObserver(entries=>{
        if(entries.some(e=>e.isIntersecting) && quantidadeFilaExibida<totalFila){
          quantidadeFilaExibida=Math.min(totalFila,quantidadeFilaExibida+20);
          renderizarResultadoProgressivo();
        }
      },{rootMargin:'120px'});
      resultObserver.observe($('resultMore'));
    }
  }

  window.addEventListener('fila-sorteio-atualizado',evento=>{
    if(!Array.isArray(evento.detail?.linhas)) return;
    lines=evento.detail.linhas;
    if(!$('result').hidden) mostrarResultado(false);
    Compartilhar.prepararLink();
  });

  const SYNC_STORAGE_KEY = 'bolleyvall-sync-manager-v1';
  function getSyncSession(){
    try { return JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY) || 'null'); }
    catch { return null; }
  }
  function deviceIdFor(sessionId){
    const key = 'bolleyvall-device:' + sessionId;
    let deviceId = sessionStorage.getItem(key);
    if (!deviceId) {
      deviceId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
          const value = Math.floor(Math.random() * 16);
          return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
        });
      sessionStorage.setItem(key, deviceId);
    }
    return deviceId;
  }
  async function finishSharedCompetition(session){
    const headers = {
      Authorization: 'Bearer ' + session.token,
      'X-Device-Id': deviceIdFor(session.id)
    };
    const sendFinish = async ()=>{
      const response = await fetch('/api/sessions/' + session.id + '/finish', {
        method: 'POST', headers
      });
      const result = await response.json();
      return { response, result };
    };
    let attempt = await sendFinish();
    if (!attempt.response.ok && attempt.result.error === 'Este aparelho precisa manter o controle ativo para alterar a sala.') {
      const recovery = await fetch('/api/sessions/' + session.id + '/control', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recover' })
      });
      const recovered = await recovery.json();
      if (!recovery.ok) throw new Error(recovered.error || 'Não foi possível recuperar o controle como organizador.');
      attempt = await sendFinish();
    }
    if (!attempt.response.ok) throw new Error(attempt.result.error || 'Não foi possível encerrar a competição.');
    return attempt.result;
  }
  function updateFinishButton(){
    const session = getSyncSession();
    const button = $('finishCompetition');
    if (!button) return;
    button.hidden = !(session?.id && session?.token && (session.status === 'active' || !session.status));
  }
  async function finishRoomIfReplaced(nextPlanId){
    const session = getSyncSession();
    if (!session?.id || !session?.token || ['finished', 'archived'].includes(session.status) || session.sourcePlanId === nextPlanId) return;
    try {
      const result = await finishSharedCompetition(session);
      localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({ ...session, status: result.status }));
      return null;
    } catch (error) {
      return 'Não foi possível encerrar a sala anterior: ' + error.message;
    }
  }

  $('finishCompetition').addEventListener('click', async ()=>{
    const session = getSyncSession();
    if (!session?.id || !session?.token || (session.status && session.status !== 'active')) return;
    if (!confirm('Encerrar esta competição? Se o controle tiver expirado, será recuperado pelo organizador. A sala continuará acessível pelos links atuais somente para visualização.')) return;
    const button = $('finishCompetition');
    button.disabled = true;
    try {
      const result = await finishSharedCompetition(session);
      localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({ ...session, status: result.status }));
      mostrarAviso('Competição encerrada. Os links atuais continuam disponíveis somente para visualização.');
      updateFinishButton();
    } catch (error) {
      alert(error.message);
    } finally { button.disabled = false; }
  });

  $('go').addEventListener('click', async ()=>{
    try{
      if(Fila.temProgresso() && !confirm('Sortear de novo encerra a sala compartilhada vinculada e apaga o acompanhamento atual (fila e resultados). Continuar?')){
        return;
      }
      lines = build();
      Fila.iniciar(currentPlan, lines, lerFormulario());
      sairDoModoVisualizadorCompartilhado();
      Compartilhar.prepararLink();
      $('avisoRecebido').hidden = true;
      mostrarResultado();
      updateFinishButton();
      const finishWarning = await finishRoomIfReplaced(currentPlan.id);
      updateFinishButton();
      if (finishWarning) mostrarAviso('O novo sorteio começou, mas ' + finishWarning);
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
  [mixed,trio,fixed,dynamic,dynamicModel2].forEach(el=> el.addEventListener('change', updateMaxUI));
  updateMaxUI();

    // guarda o que está preenchido na tela (vai junto do sorteio, no link e no salvamento)
  function lerFormulario(){
    return {
      misto: mixed.checked,
      trio: trio.checked,
      modoTrio: document.querySelector('input[name="trioMode"]:checked').value,
      permanenciaVencedor: winnerStays.checked,
      fixa: fixed.checked,
      duplaModelo2: dynamicModel2.checked,
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
    const modoTrio = ['rotativo','rotativo-modelo2'].includes(formulario.modoTrio) ? formulario.modoTrio : 'fixed';
    document.querySelector('input[name="trioMode"][value="'+modoTrio+'"]').checked = true;
    winnerStays.checked = formulario.permanenciaVencedor !== false;
    fixed.checked = formulario.fixa;
    dynamicModel2.checked = formulario.duplaModelo2 === true;
    dynamic.checked = !formulario.fixa && !dynamicModel2.checked;
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
  async function aplicarAndamentoRecebido(recebido){
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
    const finishWarning = await finishRoomIfReplaced(recebido.plano.id);
    aplicarFormulario(recebido.formulario);
    mostrarResultado(false);
    mostrarAviso('Andamento recebido (' + jogosNoLink + ' jogo(s), gerado às ' + hora + '). Você pode continuar daqui.' + (finishWarning ? ' ' + finishWarning : ''));
    updateFinishButton();
    Compartilhar.prepararLink();
  }

  // aplica um sorteio recebido (sem andamento); se houver jogos registrados, pergunta antes
  async function aplicarSorteioRecebido(recebido){
    const podeSubstituir = !Fila.temProgresso()
      || confirm('Você recebeu um sorteio novo. Isso substitui o acompanhamento atual deste aparelho. Continuar?');
    if(!podeSubstituir) return;

    lines = recebido.linhas;
    Fila.iniciar(recebido.plano, recebido.linhas, recebido.formulario);
    const finishWarning = await finishRoomIfReplaced(recebido.plano.id);
    aplicarFormulario(recebido.formulario);
    mostrarResultado(false);
    mostrarAviso('Sorteio recebido por link. O acompanhamento começa do zero neste aparelho.' + (finishWarning ? ' ' + finishWarning : ''));
    updateFinishButton();
    Compartilhar.prepararLink();
  }

  function preencherResumoCompartilhado(listId, emptyId, rows, emptyMessage) {
    const list = $(listId);
    const empty = $(emptyId);
    list.replaceChildren();
    if (!rows.length) { empty.textContent = emptyMessage; empty.hidden = false; return; }
    empty.hidden = true;
    const fragment = document.createDocumentFragment();
    rows.forEach(text => { const item = document.createElement('li'); item.textContent = text; fragment.appendChild(item); });
    list.appendChild(fragment);
  }

  function atualizarResumoCompartilhado(session) {
    const phaseIndex = session.state?.faseAtual ?? 0;
    const phase = session.plan?.fases?.[phaseIndex];
    const progress = session.state?.fases?.[phaseIndex];
    const queue = (progress?.fila || []).slice(0, 2).map(item => {
      const team = phase?.times?.[item.id]?.join(' + ') || `Time ${item.id + 1}`;
      return team + (item.jogou ? ' · já jogou' : '');
    });
    const historyRows = [...(session.state?.historico || [])].slice(-5).reverse().map(match =>
      `${match.vencedor || 'Vencedor'} VENCEU ${match.perdedor || 'adversário'}`
    );
    const counts = new Map();
    for (const match of session.state?.historico || []) {
      for (const name of match.vencedores || []) {
        const row = counts.get(name) || { wins: 0, games: 0 };
        row.wins += 1; row.games += 1; counts.set(name, row);
      }
      for (const name of match.perdedores || []) {
        const row = counts.get(name) || { wins: 0, games: 0 };
        row.games += 1; counts.set(name, row);
      }
    }
    const ranking = [...counts.entries()]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.wins - a.wins || a.games - b.games || a.name.localeCompare(b.name, 'pt-BR'))
      .map(player => `${player.name} · ${player.wins} vitória(s) em ${player.games} jogo(s)`);
    preencherResumoCompartilhado('sharedQueue', 'sharedQueueEmpty', queue, 'Sem times aguardando.');
    preencherResumoCompartilhado('sharedHistory', 'sharedHistoryEmpty', historyRows, 'Nenhuma partida encerrada.');
    preencherResumoCompartilhado('sharedRanking', 'sharedRankingEmpty', ranking, 'O ranking aparece após a primeira partida.');
    const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(Date.now());
    $('sharedStatus').textContent = `Conectado · Atualizado ${time} · Revisão ${session.revision}`;
  }

  async function consultarResumoCompartilhado() {
    if (!sharedViewerContext || sharedViewerRequestActive) return;
    sharedViewerRequestActive = true;
    try {
      const response = await fetch(`/api/sessions/${sharedViewerContext.id}`, {
        headers: { Authorization: `Bearer ${sharedViewerContext.token}`, 'X-Device-Id': deviceIdFor(sharedViewerContext.id) }, cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível carregar a sala.');
      atualizarResumoCompartilhado(data);
    } catch (error) {
      $('sharedStatus').textContent = error.message === 'Acesso inválido ou expirado.'
        ? 'Este link de visualização foi revogado.' : 'Reconectando à sala…';
    } finally { sharedViewerRequestActive = false; }
  }

  function iniciarModoVisualizadorCompartilhado() {
    const id = new URLSearchParams(location.search).get('visualizador');
    const tokenPrefix = '#visualizador=';
    const token = location.hash.startsWith(tokenPrefix) ? decodeURIComponent(location.hash.slice(tokenPrefix.length)) : '';
    if (!/^[0-9a-f-]{36}$/i.test(id || '') || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return;
    sharedViewerContext = { id, token };
    $('sharedViewerNote').hidden = false;
    $('sharedProgress').hidden = false;
    $('sharedProgress').open = true;
    $('backLink').href = `/s/${id}?semModal=1#${encodeURIComponent(token)}`;
    $('tracker').hidden = true;
    $('result').hidden = true;
    $('avisoRecebido').hidden = true;
    consultarResumoCompartilhado();
    sharedViewerPoll = setInterval(consultarResumoCompartilhado, 2000);
  }

  function sairDoModoVisualizadorCompartilhado() {
    if (!sharedViewerContext) return;
    sharedViewerContext = null;
    if (sharedViewerPoll) clearInterval(sharedViewerPoll);
    sharedViewerPoll = null;
    $('sharedProgress').hidden = true;
    $('sharedViewerNote').hidden = true;
    $('backLink').href = '/';
    history.replaceState(null, '', location.pathname);
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
      await aplicarAndamentoRecebido(recebido);
    }else{
      await aplicarSorteioRecebido(recebido);
    }
    Compartilhar.limparLinkDaBarra();
  }
  ArmazenamentoLocal.ready.then(async ()=>{ iniciarModoVisualizadorCompartilhado(); await abrirSorteioInicial(); if (sharedViewerContext) { $("tracker").hidden = true; $("result").hidden = true; $("avisoRecebido").hidden = true; } updateFinishButton(); });
  
})();
