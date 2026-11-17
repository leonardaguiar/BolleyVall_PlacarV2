// fila.js - acompanhamento da fila do sorteio.
//
// Regras:
//  - o vencedor fica em quadra por no máximo UM jogo adicional (2 jogos seguidos);
//  - quem perde vai para o final da fila;
//  - o desafiante é sempre o primeiro da fila que ainda não "jogou" nesta volta.
//
// Modos de cada fase (rodada):
//  - 'fila': times em quadra + fila de espera (dupla fixa, trio, dupla dinâmica sem rodadas);
//  - 'jogo': um único jogo por rodada, sem fila (dupla dinâmica com rodadas).
const Fila = (function () {
  'use strict';

  const CHAVE_STORAGE = 'sorteio-acompanhamento-v1';
  const CHAVE_PEDIDO_PLACAR = 'placar-encerrar-partida-v1';
  const JOGOS_SEGUIDOS_MAXIMO = 2;   // o jogo em que entrou + uma partida adicional
  const LIMITE_DESFAZER = 30;

  let plano = null;            // { unit, fases: [{ titulo, modo, times: [[nomes]] }] }
  let estado = null;           // andamento: quadra, fila, histórico e pilha de desfazer
  let linhasDoSorteio = [];    // lista pura do sorteio (para copiar/PDF depois de recarregar)
  let formularioDoSorteio = null;   // o que foi preenchido na tela no momento do sorteio
  let filaObserver = null;
  const TIPO_FORMATO = ['trio-rotativo','trio-rotativo-modelo2','trio-fixo','dupla-dinamica','dupla-dinamica-modelo2','dupla-fixa','dupla-rodadas'];

  const $ = id => document.getElementById(id);

  function gerarIdPlano() {
    return 'sorteio-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---------- acesso rápido ao que está em andamento ----------
  const faseAtual = () => estado.fases[estado.faseAtual];
  const dadosDaFase = () => plano.fases[estado.faseAtual];
  const rotulo = id => plano.unit + ' ' + (id + 1);
  const descricao = id => rotulo(id) + ': ' + dadosDaFase().times[id].join(' + ');
  const timeIncompleto = id => dadosDaFase().times[id].length < (plano.tamanho || 0);
  const chavePessoa = nome => String(nome).trim().toLocaleLowerCase('pt-BR');

  function normalizarParticipantes(){
    if(!plano) return [];
    if(!Array.isArray(plano.participantes)){
      const nomes=new Map();
      (plano.fases||[]).forEach(f=> (f.times||[]).forEach(t=> (t||[]).forEach(n=>{
        if(!nomes.has(chavePessoa(n))) nomes.set(chavePessoa(n),{n:n,g:null});
      })));
      const form=formularioDoSorteio;
      if(form){
        if(form.misto){
          (form.homens||'').split(/[,;\n]+/).map(n=>n.trim()).filter(Boolean).forEach(n=>nomes.set(chavePessoa(n),{n:n,g:'M'}));
          (form.mulheres||'').split(/[,;\n]+/).map(n=>n.trim()).filter(Boolean).forEach(n=>nomes.set(chavePessoa(n),{n:n,g:'F'}));
        }else (form.todos||'').split(/[,;\n]+/).map(n=>n.trim()).filter(Boolean).forEach(n=>nomes.set(chavePessoa(n),{n:n,g:null}));
      }
      plano.participantes=Array.from(nomes.values());
    }
    if(!plano.configuracao){
      const trio=plano.tamanho===3;
      const form=formularioDoSorteio||{};
      const tipo=trio?(form.modoTrio==='rotativo-modelo2'?'trio-rotativo-modelo2':form.modoTrio==='rotativo'?'trio-rotativo':'trio-fixo'):(form.fixa?'dupla-fixa':form.duplaModelo2?'dupla-dinamica-modelo2':form.rodadas?'dupla-rodadas':'dupla-dinamica');
      plano.configuracao={tipo:tipo,tipoTrioOriginal:trio?tipo:null,misto:form.misto===true,cap:null,permanencia:form.permanenciaVencedor!==false,rodadas:Number(form.rodadas)||0,tamanho:plano.tamanho||2};
    }
    if(!TIPO_FORMATO.includes(plano.configuracao.tipo)) plano.configuracao.tipo=plano.tamanho===3?'trio-fixo':'dupla-dinamica';
    return plano.participantes;
  }

  function inicializarGestao(){
    const stats={};
    normalizarParticipantes().forEach(p=>{stats[chavePessoa(p.n)]={espera:0,partidas:0};});
    return {ausentes:[],stats:stats,mensagem:'',aguardandoFormato:null};
  }

  function ativos(){
    const ausentes=new Set((estado?.gestao?.ausentes||[]).map(chavePessoa));
    return normalizarParticipantes().filter(p=>!ausentes.has(chavePessoa(p.n)));
  }

  function obterStats(nome){
    const chave=chavePessoa(nome), gestao=estado.gestao;
    if(!gestao.stats[chave]) gestao.stats[chave]={espera:0,partidas:0};
    return gestao.stats[chave];
  }

  function normalizarStatsGestao(){
    if(!estado.gestao) estado.gestao=inicializarGestao();
    if(!Array.isArray(estado.gestao.ausentes)) estado.gestao.ausentes=[];
    if(!estado.gestao.stats||typeof estado.gestao.stats!=='object') estado.gestao.stats={};
    normalizarParticipantes().forEach(p=>obterStats(p.n));
  }

  function criarEsperaRotativa(config,quadra,times){
    if(!config || config.modo!=='reservas') return null;
    const espera={}, partidas={};
    config.jogadores.forEach(p=>{
      const chave=chavePessoa(p.n);
      espera[chave]=0;
      partidas[chave]=0;
    });
    return {espera:espera,partidas:partidas};
  }

  // ---------- criação do estado ----------
  function criarEstadoDaFase(fase) {
    const ids = fase.times.map((_, indice) => indice);
    const sequencia = {};
    sequencia[ids[0]] = 1;
    sequencia[ids[1]] = 1;
    return {
      quadra: [ids[0], ids[1]],                               // os dois primeiros jogam
      fila: (Array.isArray(fase.preparados)?fase.preparados:ids.slice(2)).map(id => ({ id: id, jogou: false })),
      sequencia: sequencia,                                   // jogos seguidos de cada time em quadra
      jogos: 0,
      vencedor: null,                                         // só usado no modo 'jogo'
      filaVisivel: 20,
      revisaoJogo: 0,
      bloqueada: false,
      modelo2: fase.modelo2||null,
      rotativoEstado: criarEsperaRotativa(fase.rotativo,[ids[0],ids[1]],fase.times)
    };
  }

  function iniciar(novoPlano, linhas, formulario)  {
    plano = novoPlano;
    if (!plano.id) plano.id = gerarIdPlano();
    linhasDoSorteio = linhas;
    formularioDoSorteio = formulario || null;
    estado = {
      faseAtual: 0,
      fases: plano.fases.map(criarEstadoDaFase),
      historico: [],
      desfazer: [],
      gestao: inicializarGestao()
    };
    salvar();
    renderizar();
  }

  function carregar() {
    try {
      const bruto = ArmazenamentoLocal.getItem(CHAVE_STORAGE);
      if (!bruto) return null;
      const salvo = JSON.parse(bruto);
      plano = salvo.plano;
      if (!plano.id) plano.id = gerarIdPlano();
      estado = salvo.estado;
      linhasDoSorteio = salvo.linhas;
      formularioDoSorteio = salvo.formulario || null;
      normalizarParticipantes();
      if(!estado.gestao) estado.gestao=inicializarGestao();
      normalizarStatsGestao();
      renderizar();
    return { linhas: salvo.linhas, formulario: formularioDoSorteio };
    } catch (erro) {
      return null;
    }
  }

  function salvar() {
    try {
      ArmazenamentoLocal.setItem(CHAVE_STORAGE, JSON.stringify({
        plano: plano,
        estado: estado,
        linhas: linhasDoSorteio,
        formulario: formularioDoSorteio
        
      }));
    } catch (erro) { /* sem localStorage (ex.: aba privada): segue sem salvar */ }
  }

  function temProgresso() {
    return !!estado && estado.historico.length > 0;
  }

  // ---------- desfazer ----------
  function guardarParaDesfazer() {
    estado.desfazer.push(JSON.stringify({
      faseAtual: estado.faseAtual,
      fases: estado.fases,
      historico: estado.historico,
      gestao: estado.gestao,
      plano: plano
    }));
    if (estado.desfazer.length > LIMITE_DESFAZER) estado.desfazer.shift();
  }

  function desfazerUltimaAcao() {
    const anterior = estado.desfazer.pop();
    if (!anterior) return;
    const dados = JSON.parse(anterior);
    estado.faseAtual = dados.faseAtual;
    estado.fases = dados.fases;
    estado.historico = dados.historico;
    if(dados.gestao) estado.gestao=dados.gestao;
    if(dados.plano) plano=dados.plano;
    finalizarAcao();
  }

  function finalizarAcao() {
    salvar();
    renderizar();
  }

  // ---------- regras da fila ----------
  // Próximo = primeiro da fila que ainda não jogou nesta volta.
  // Se todos já jogaram, começa uma nova volta (limpa as marcações).
  function retirarProximoDaFila(fase) {
    if (fase.fila.every(item => item.jogou)) {
      fase.fila.forEach(item => { item.jogou = false; });
    }
    const posicao = fase.fila.findIndex(item => !item.jogou);
    return fase.fila.splice(posicao, 1)[0].id;
  }

  function idDoProximo(fase) {
    const livre = fase.fila.find(item => !item.jogou);
    if (livre) return livre.id;
    return fase.fila.length ? fase.fila[0].id : null;
  }

  function compartilhaJogador(fase,idA,idB){
    const A=new Set((dadosDaFase().times[idA]||[]).map(chavePessoa));
    return (dadosDaFase().times[idB]||[]).some(p=>A.has(chavePessoa(p)));
  }

  function retirarProximoCompativel(fase,idContra){
    for(let tentativa=0;tentativa<2;tentativa++){
      if(fase.fila.length && fase.fila.every(item=>item.jogou)) fase.fila.forEach(item=>{item.jogou=false;});
      if(tentativa===1) fase.fila.forEach(item=>{item.jogou=false;});
      const pos=fase.fila.findIndex(item=>!item.jogou && !compartilhaJogador(fase,item.id,idContra));
      if(pos>=0) return fase.fila.splice(pos,1)[0].id;
    }
    return null;
  }

  function retirarDoisCompativeis(fase){
    for(let tentativa=0;tentativa<2;tentativa++){
      if(fase.fila.length>1 && fase.fila.every(item=>item.jogou)) fase.fila.forEach(item=>{item.jogou=false;});
      for(let i=0;i<fase.fila.length;i++){
        if(fase.fila[i].jogou) continue;
        for(let j=i+1;j<fase.fila.length;j++){
          if(fase.fila[j].jogou || compartilhaJogador(fase,fase.fila[i].id,fase.fila[j].id)) continue;
          const a=fase.fila[i].id,b=fase.fila[j].id;
          fase.fila.splice(j,1); fase.fila.splice(i,1);
          return [a,b];
        }
      }
      fase.fila.forEach(item=>{item.jogou=false;});
    }
    return null;
  }

  function escolherEquipesAoVivo(fase,quantas,foraDaQuadra,tamanho,fonteParticipantes){
    const config=plano.configuracao, k=tamanho||plano.tamanho||3;
    const excluidos=new Set((foraDaQuadra||[]).map(chavePessoa));
    const restantes=(fonteParticipantes||ativos()).filter(p=>!excluidos.has(chavePessoa(p.n)));
    const prioridade=p=>{
      const stat=obterStats(p.n);
      return stat.espera*100-stat.partidas*4;
    };
    const empatados=list=>list.map(p=>({p:p,t:Math.random()})).sort((a,b)=>prioridade(b.p)-prioridade(a.p)||a.t-b.t).map(x=>x.p);
    const homens=empatados(restantes.filter(p=>p.g==='M'));
    const mulheres=empatados(restantes.filter(p=>p.g==='F'));
    if(!config.misto){
      const selecionados=empatados(restantes).slice(0,quantas*k);
      if(selecionados.length<quantas*k) return null;
      const embaralhados=selecionados.sort(()=>Math.random()-.5);
      return {equipes:Array.from({length:quantas},(_,i)=>embaralhados.slice(i*k,i*k+k))};
    }

    function montar(cap,relaxado){
      const opcoes=[];
      const buscar=(atuais)=>{
        if(atuais.length===quantas){
          const totalM=atuais.reduce((a,b)=>a+b,0),totalF=quantas*k-totalM;
          if(totalM>homens.length||totalF>mulheres.length) return;
          if(cap&&k===3){
            if(cap.exact&&!relaxado&&atuais.some(n=>n!==cap.N)) return;
            if(!cap.exact&&atuais.some(n=>n>cap.N)) return;
            if(cap.exact&&relaxado&&atuais.some(n=>n>cap.N)) return;
          }
          const ms=homens.slice(0,totalM),fs=mulheres.slice(0,totalF),equipes=[];
          let mi=0,fi=0,score=0;
          atuais.forEach(n=>{
            const equipe=[...ms.slice(mi,mi+n),...fs.slice(fi,fi+k-n)];
            mi+=n; fi+=k-n;
            score+=equipe.reduce((s,p)=>s+prioridade(p),0);
            if(equipe.some(p=>p.g==='M')&&equipe.some(p=>p.g==='F')) score+=config.misto?1000000:0;
            equipes.push(equipe);
          });
          if(quantas===2){
            const esperas=equipes.map(t=>t.reduce((s,p)=>s+obterStats(p.n).espera,0));
            score-=Math.abs(esperas[0]-esperas[1])*2;
          }
          opcoes.push({equipes,score:score+Math.random()});
          return;
        }
        for(let n=0;n<=k;n++){
          if(cap&&k===3&&!relaxado&&cap.exact&&n!==cap.N) continue;
          if(cap&&k===3&&(!cap.exact||relaxado)&&n>cap.N) continue;
          atuais.push(n); buscar(atuais); atuais.pop();
        }
      };
      buscar([]);
      return opcoes.sort((a,b)=>b.score-a.score)[0]||null;
    }
    return montar(config.cap,false)|| (config.cap&&config.cap.exact ? montar({...config.cap,exact:false},true) : null) || montar(null,true);
  }

  function atualizarEspera(fase){
    const emQuadra=new Set(fase.quadra.flatMap(id=>dadosDaFase().times[id]||[]).map(chavePessoa));
    const ausentes=new Set(estado.gestao.ausentes.map(chavePessoa));
    normalizarParticipantes().forEach(p=>{
      if(ausentes.has(chavePessoa(p.n))) return;
      const k=chavePessoa(p.n);
      const stat=obterStats(p.n);
      if(emQuadra.has(k)){ stat.espera=0; stat.partidas+=1; }
      else stat.espera+=1;
    });
  }

  function prioridadePessoa(p){
    const stat=obterStats(p.n);
    return stat.espera*100-stat.partidas*4;
  }

  function gerarCombinacoes(pessoas,tamanho){
    const saida=[];
    (function buscar(inicio,atual){
      if(atual.length===tamanho){saida.push(atual.slice());return;}
      for(let i=inicio;i<pessoas.length;i++){atual.push(pessoas[i]);buscar(i+1,atual);atual.pop();}
    })(0,[]);
    return saida;
  }

  function assinaturaEquipe(time){return (time||[]).map(chavePessoa).sort().join('|');}

  function gruposFixos(pessoas,tamanho,config){
    const restantes=pessoas.slice().sort((a,b)=>prioridadePessoa(b)-prioridadePessoa(a)||Math.random()-.5);
    const grupos=[];
    const max= tamanho===3 ? config.cap : null;
    const politica=capModo=>{
      const pool=restantes.slice(), saida=[];
      while(pool.length>=tamanho){
        let escolhidos=[];
        if(config.misto){
          const mulheres=pool.filter(p=>p.g==='F'), homens=pool.filter(p=>p.g==='M');
          let mMax=capModo ? capModo.N : tamanho;
          if(capModo&&capModo.exact) mMax=capModo.N;
          const minM=capModo&&capModo.exact ? capModo.N : 0;
          let candidatos=[];
          for(let n=minM;n<=Math.min(mMax,tamanho,homens.length);n++){
            if(mulheres.length<tamanho-n) continue;
            const ms=homens.slice(0,n),fs=mulheres.slice(0,tamanho-n);
            if(ms.length+fs.length===tamanho) candidatos.push([...ms,...fs]);
          }
          candidatos.sort((a,b)=>{
            const ma=a.some(p=>p.g==='M')&&a.some(p=>p.g==='F'),mb=b.some(p=>p.g==='M')&&b.some(p=>p.g==='F');
            return Number(mb)-Number(ma)||b.reduce((s,p)=>s+prioridadePessoa(p),0)-a.reduce((s,p)=>s+prioridadePessoa(p),0);
          });
          escolhidos=candidatos[0]||[];
        }else escolhidos=pool.slice(0,tamanho);
        if(escolhidos.length<tamanho) escolhidos=pool.slice(0,tamanho);
        if(escolhidos.length<tamanho) break;
        saida.push(escolhidos);
        const used=new Set(escolhidos.map(p=>chavePessoa(p.n)));
        for(let i=pool.length-1;i>=0;i--) if(used.has(chavePessoa(pool[i].n))) pool.splice(i,1);
      }
      return saida;
    };
    if(max&&config.misto&&max.exact){
      const exact=politica(max);
      if(exact.length>=2) return exact;
      const loose=politica({...max,exact:false});
      if(loose.length>=2) return loose;
      return politica(null);
    }
    return politica(max);
  }

  function timesHistoricos(){
    const usados={};
    (estado?.historico||[]).forEach(j=>[j.vencedores||[],j.perdedores||[]].forEach(t=>{
      const k=assinaturaEquipe(t);usados[k]=(usados[k]||0)+1;
    }));
    return usados;
  }

  function gerarFilaDinamica(pessoas,tamanho,config,fase){
    const current=new Set((fase?.quadra||[]).map(id=>assinaturaEquipe(dadosDaFase().times[id]||[])));
    const hist=timesHistoricos();
    let times=gerarCombinacoes(pessoas,tamanho);
    if(tamanho===3&&config.cap){
      times=times.filter(t=>{
        const homens=t.filter(p=>p.g==='M').length;
        return config.cap.exact ? homens===config.cap.N : homens<=config.cap.N;
      });
    }
    return times.filter(t=>!current.has(assinaturaEquipe(t.map(p=>p.n))))
      .map(t=>({t,used:hist[assinaturaEquipe(t.map(p=>p.n))]||0,score:t.reduce((s,p)=>s+prioridadePessoa(p),0)+((t.some(p=>p.g==='M')&&t.some(p=>p.g==='F')&&config.misto)?1000000:0)+Math.random()}))
      .sort((a,b)=>a.used-b.used||b.score-a.score).map(x=>x.t.map(p=>p.n));
  }

  function gerarCombinacoesModelo2(pessoas,tamanho,cap){
    if(tamanho===3&&cap){
      const homens=pessoas.filter(p=>p.g==='M').length,mulheres=pessoas.length-homens;
      const possivel=cap.exact?homens>=cap.N&&mulheres>=3-cap.N:Array.from({length:Math.min(cap.N,3)+1},(_,n)=>n).some(n=>homens>=n&&mulheres>=3-n);
      if(!possivel) return [];
    }
    const saida=[],pool=pessoas.slice();
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    (function buscar(inicio,atual){
      if(saida.length>=2000) return;
      if(atual.length===tamanho){
        if(tamanho!==3||!cap){saida.push(atual.slice());return;}
        const homens=atual.filter(p=>p.g==='M').length;
        if(cap.exact?homens===cap.N:homens<=cap.N) saida.push(atual.slice());
        return;
      }
      for(let i=inicio;i<pool.length&&saida.length<2000;i++){atual.push(pool[i]);buscar(i+1,atual);atual.pop();}
    })(0,[]);
    return saida;
  }

  function atualizarListaCompartilhadaModelo2(fase){
    if(!fase?.modelo2) return;
    const modelo=fase.modelo2;
    const participantes=ativos();
    const combinacoes=gerarCombinacoesModelo2(participantes,modelo.tamanho,modelo.cap);
    modelo.jogadores=participantes.map(p=>({...p}));
    modelo.totalCombinacoes=participantes.length*(participantes.length-1)*(modelo.tamanho===3?participantes.length-2:1)/(modelo.tamanho===3?6:2);
    modelo.combinacoesCompartilhadas=combinacoes.map(time=>time.map(p=>p.n));
    dadosDaFase().modelo2=modelo;
    const inicio=linhasDoSorteio.findIndex(linha=>linha[0]==='model2-header');
    if(inicio<0) return;
    const sufixo=linhasDoSorteio.slice(inicio+1).filter(linha=>linha[0]!=='q'&&linha[0]!=='sig'&&!(linha[0]==='m'&&/combinações possíveis|composições de .* possíveis/i.test(linha[1])));
    const linhas=[...linhasDoSorteio.slice(0,inicio),['model2-header','COMBINAÇÕES POSSÍVEIS (ordem de referência; a fila do app é montada durante os jogos)']];
    combinacoes.forEach((time,i)=>linhas.push(['q',plano.unit+' '+(i+1)+': '+time.map(p=>p.n).join(' + ')]));
    linhas.push(['m',(modelo.totalCombinacoes>2000?'Lista compartilhada limitada a 2.000 composições de '+modelo.totalCombinacoes.toLocaleString('pt-BR')+' possíveis. ':modelo.totalCombinacoes.toLocaleString('pt-BR')+' combinações possíveis. ')+'A fila do acompanhamento prioriza quem está há mais tempo sem jogar e tenta evitar repetir formações ainda não usadas.']);
    linhas.push(...sufixo);
    const corpo=linhas.map(linha=>linha[1]).join('|');
    let hash=5381;
    for(const caractere of corpo) hash=((hash<<5)+hash+caractere.charCodeAt(0))>>>0;
    linhas.push(['sig','Sorteio gerado pelo app BolleyVall Placar em '+new Date().toLocaleString('pt-BR')+' | Assinatura BVP-'+hash.toString(16).toUpperCase().padStart(8,'0')]);
    linhasDoSorteio=linhas;
    window.dispatchEvent(new CustomEvent('fila-sorteio-atualizado',{detail:{linhas:linhas}}));
  }

  function escolherFormacoesModelo2(fase,pessoas,quantas,nomesReservados=[]){
    const modelo=fase.modelo2,k=modelo.tamanho;
    if(!modelo||quantas<1) return [];
    const reservados=new Set(nomesReservados.map(chavePessoa));
    const candidatos=gerarCombinacoesModelo2(pessoas,k,modelo.cap).filter(time=>time.every(p=>!reservados.has(chavePessoa(p.n))));
    const usadas=new Set(modelo.usadas||[]);
    const pontuar=time=>{
      const espera=time.reduce((s,p)=>s+prioridadePessoa(p),0);
      const misto=modelo.misto&&time.some(p=>p.g==='M')&&time.some(p=>p.g==='F')?1000000:0;
      const nova=usadas.has(assinaturaEquipe(time.map(p=>p.n)))?0:1000000000;
      return espera+misto+nova+Math.random();
    };
    const avaliados=candidatos.map(time=>({time,score:pontuar(time),espera:time.reduce((s,p)=>s+obterStats(p.n).espera,0)}));
    if(quantas===1){
      const melhor=avaliados.sort((a,b)=>b.score-a.score)[0];
      return melhor?[melhor.time]:[];
    }
    let melhor=null,melhorScore=-Infinity;
    for(let i=0;i<avaliados.length;i++){
      const nomes=new Set(avaliados[i].time.map(p=>chavePessoa(p.n)));
      for(let j=i+1;j<avaliados.length;j++){
        if(avaliados[j].time.some(p=>nomes.has(chavePessoa(p.n)))) continue;
        const score=avaliados[i].score+avaliados[j].score-Math.abs(avaliados[i].espera-avaliados[j].espera)*2;
        if(score>melhorScore){melhorScore=score;melhor=[avaliados[i].time,avaliados[j].time];}
      }
    }
    if(melhor) return melhor;
    const melhorTime=avaliados.sort((a,b)=>b.score-a.score)[0];
    return melhorTime?[melhorTime.time]:[];
  }

  function adicionarTimeModelo2(fase,time){
    const assinatura=assinaturaEquipe(time.map(p=>p.n));
    let id=dadosDaFase().times.findIndex(timeExistente=>assinaturaEquipe(timeExistente)===assinatura);
    if(id<0){id=dadosDaFase().times.length;dadosDaFase().times.push(time.map(p=>p.n));}
    fase.sequencia[id]=0;
    fase.modelo2.usadas=fase.modelo2.usadas||[];
    if(!fase.modelo2.usadas.includes(assinatura)) fase.modelo2.usadas.push(assinatura);
    return id;
  }

  function completarFilaModelo2(fase){
    const modelo=fase.modelo2;if(!modelo) return;
    const emQuadra=new Set(fase.quadra.flatMap(id=>dadosDaFase().times[id]||[]).map(chavePessoa));
    const reservados=new Set(fase.fila.flatMap(item=>dadosDaFase().times[item.id]||[]).map(chavePessoa));
    const disponiveis=ativos().filter(p=>!emQuadra.has(chavePessoa(p.n))&&!reservados.has(chavePessoa(p.n)));
    const vagas=Math.min(2-fase.fila.length,Math.floor(disponiveis.length/modelo.tamanho));
    if(vagas<1) return;
    const novos=escolherFormacoesModelo2(fase,disponiveis,vagas);
    novos.forEach(time=>fase.fila.push({id:adicionarTimeModelo2(fase,time),jogou:false}));
  }

  function atualizarFilaModelo2DepoisDoJogo(fase,idVencedor){
    const modelo=fase.modelo2,k=modelo.tamanho;
    modelo.usadas=modelo.usadas||[];
    fase.quadra.forEach(id=>{
      const assinatura=assinaturaEquipe(dadosDaFase().times[id]||[]);
      if(assinatura&&!modelo.usadas.includes(assinatura)) modelo.usadas.push(assinatura);
    });
    const preparados=fase.fila.map(item=>item.id);
    const permanece=modelo.permanencia&&fase.sequencia[idVencedor]<JOGOS_SEGUIDOS_MAXIMO;
    fase.fila=[];
    if(permanece){
      let adversario=preparados.shift();
      if(adversario===undefined){
        const nomesVencedores=dadosDaFase().times[idVencedor];
        const escolhido=escolherFormacoesModelo2(fase,ativos(),1,nomesVencedores);
        if(escolhido.length) adversario=adicionarTimeModelo2(fase,escolhido[0]);
      }
      if(adversario===undefined){
        fase.bloqueada=true;estado.gestao.mensagem='Não foi possível formar a próxima equipe. Reative ou adicione participantes para continuar.';return;
      }
      fase.quadra=[idVencedor,adversario];
      fase.sequencia[idVencedor]=(fase.sequencia[idVencedor]||1)+1;
      fase.sequencia[adversario]=1;
      preparados.forEach(id=>fase.fila.push({id:id,jogou:false}));
    }else{
      let proximos=preparados.slice(0,2);
      while(proximos.length<2){
        const reservados=proximos.flatMap(id=>dadosDaFase().times[id]||[]);
        const restantes=escolherFormacoesModelo2(fase,ativos(),2-proximos.length,reservados);
        if(!restantes.length) break;
        const antes=proximos.length;
        restantes.forEach(time=>proximos.push(adicionarTimeModelo2(fase,time)));
        if(proximos.length===antes) break;
      }
      if(proximos.length<2){
        fase.bloqueada=true;estado.gestao.mensagem='Não foi possível formar duas equipes para a próxima partida. Reative ou adicione participantes para continuar.';return;
      }
      fase.quadra=proximos.slice(0,2);
      fase.quadra.forEach(id=>fase.sequencia[id]=1);
      preparados.slice(2).forEach(id=>fase.fila.push({id:id,jogou:false}));
    }
    fase.bloqueada=false;
    estado.gestao.mensagem='';
    completarFilaModelo2(fase);
  }

  function adicionarTimesNaFila(fase,times){
    fase.fila=[];
    times.forEach(time=>{
      const id=dadosDaFase().times.length;
      dadosDaFase().times.push(time);
      fase.sequencia[id]=0;
      fase.fila.push({id:id,jogou:false});
    });
    fase.filaVisivel=20;
  }

  function reconstruirFila(fase,redesenharQuadra,forcarDuplas=false){
    const config=plano.configuracao, participantes=ativos(), k=plano.tamanho;
    const precisaTrio=String(config.tipo).startsWith('trio-');
    if((precisaTrio&&participantes.length<6)||forcarDuplas){
      config.tipoTrioOriginal=config.tipoTrioOriginal||config.tipo;
      config.tipo=config.tipo==='trio-rotativo-modelo2'?'dupla-dinamica-modelo2':'dupla-dinamica';
      plano.unit='Dupla';plano.tamanho=2;
      fase.rotativo=null;fase.dinamico=true;fase.modo='fila';dadosDaFase().modo='fila';dadosDaFase().rotativo=null;dadosDaFase().dinamico=true;
      if(config.tipo==='dupla-dinamica-modelo2') fase.modelo2={tamanho:2,jogadores:participantes.map(p=>({...p})),misto:config.misto,cap:null,permanencia:true,totalCombinacoes:participantes.length*(participantes.length-1)/2,combinacoesCompartilhadas:[],usadas:[]};
      {
        const formados=participantes.length>=4?(fase.modelo2?escolherFormacoesModelo2(fase,participantes,2):escolherEquipesAoVivo(fase,2,[],2,participantes)):null;
        if(!formados||(fase.modelo2?formados.length<2:!formados.equipes)){fase.bloqueada=true;fase.quadra=[fase.quadra[0],fase.quadra[1]];fase.revisaoJogo=(fase.revisaoJogo||0)+1;adicionarTimesNaFila(fase,[]);if(fase.modelo2)atualizarListaCompartilhadaModelo2(fase);return false;}
        fase.bloqueada=false;
        fase.quadra=(fase.modelo2?formados:formados.equipes).map(time=>{
          const id=fase.modelo2?adicionarTimeModelo2(fase,time):adicionarTrioAoPlano(fase,time);fase.sequencia[id]=1;return id;
        });
        fase.revisaoJogo=(fase.revisaoJogo||0)+1;
      }
      if(fase.modelo2){fase.fila=[];completarFilaModelo2(fase);atualizarListaCompartilhadaModelo2(fase);}
      else adicionarTimesNaFila(fase,gerarFilaDinamica(participantes,2,config,fase));
      if(estado.faseAtual<plano.fases.length-1) atualizarFuturasRodadas(estado.faseAtual);
      return true;
    }

    if(participantes.length<4){
      fase.fila=[];fase.bloqueada=!!redesenharQuadra;
      estado.gestao.mensagem='Não é possível montar partidas com menos de quatro pessoas disponíveis.';
      if(fase.modelo2) atualizarListaCompartilhadaModelo2(fase);
      return false;
    }

    if(config.tipo==='trio-rotativo-modelo2'||config.tipo==='dupla-dinamica-modelo2'){
      const tamanho=plano.tamanho;
      fase.modelo2=fase.modelo2||{tamanho:tamanho,usadas:[]};
      Object.assign(fase.modelo2,{tamanho:tamanho,jogadores:participantes.map(p=>({...p})),misto:config.misto,cap:tamanho===3?config.cap:null,permanencia:tamanho===3?(participantes.length===6?false:config.permanencia):true,totalCombinacoes:participantes.length*(participantes.length-1)*(tamanho===3?participantes.length-2:1)/(tamanho===3?6:2)});
      fase.dinamico=true;fase.rotativo=null;dadosDaFase().rotativo=null;dadosDaFase().dinamico=true;
      if(redesenharQuadra){
        const times=escolherFormacoesModelo2(fase,participantes,2);
        if(times.length<2){fase.bloqueada=true;fase.revisaoJogo=(fase.revisaoJogo||0)+1;adicionarTimesNaFila(fase,[]);return false;}
        fase.bloqueada=false;
        fase.quadra=times.map(time=>{const id=adicionarTimeModelo2(fase,time);fase.sequencia[id]=1;return id;});
        fase.revisaoJogo=(fase.revisaoJogo||0)+1;
      }
      fase.fila=[];
      completarFilaModelo2(fase);
      atualizarListaCompartilhadaModelo2(fase);
      return !fase.bloqueada;
    }

    if(redesenharQuadra){
      const times=escolherEquipesAoVivo(fase,2,[],k);
      if(!times){
        fase.bloqueada=true;fase.revisaoJogo=(fase.revisaoJogo||0)+1;
        adicionarTimesNaFila(fase,[]);return false;
      }
      fase.bloqueada=false;
      fase.quadra=times.equipes.map(time=>{const id=adicionarTrioAoPlano(fase,time);fase.sequencia[id]=1;return id;});
      fase.revisaoJogo=(fase.revisaoJogo||0)+1;
    }

    if(config.tipo==='trio-rotativo'){
      const total=participantes.length*(participantes.length-1)*(participantes.length-2)/6;
      const completo=participantes.length%3===0&&total<=2000;
      fase.rotativo={modo:completo?'completo':'reservas',jogadores:participantes.map(p=>({...p})),misto:config.misto,cap:config.cap,permanencia:participantes.length===6?false:config.permanencia,combinacoesCompletas:completo,totalCombinacoes:total};
      fase.dinamico=true;dadosDaFase().rotativo=fase.rotativo;dadosDaFase().dinamico=true;
      fase.rotativoEstado={espera:{},partidas:{}};
      participantes.forEach(p=>{const k=chavePessoa(p.n),stat=obterStats(p.n);fase.rotativoEstado.espera[k]=stat.espera;fase.rotativoEstado.partidas[k]=stat.partidas;});
      adicionarTimesNaFila(fase,completo?gerarFilaDinamica(participantes,3,config,fase):[]);
    }else if(config.tipo==='dupla-dinamica'){
      fase.rotativo=null;fase.dinamico=true;dadosDaFase().rotativo=null;dadosDaFase().dinamico=true;
      adicionarTimesNaFila(fase,gerarFilaDinamica(participantes,2,config,fase));
    }else{
      fase.rotativo=null;fase.dinamico=false;dadosDaFase().rotativo=null;dadosDaFase().dinamico=false;
      const nomesQuadra=new Set((fase.quadra||[]).flatMap(id=>dadosDaFase().times[id]||[]).map(chavePessoa));
      const fora=participantes.filter(p=>!nomesQuadra.has(chavePessoa(p.n)));
      adicionarTimesNaFila(fase,gruposFixos(fora,k,config).map(t=>t.map(p=>p.n)));
    }
    return !fase.bloqueada;
  }

  function atualizarFuturasRodadas(indiceAtual){
    if(plano.configuracao.tipo==='dupla-dinamica'){
      const duplas=gerarCombinacoes(ativos(),2).map(t=>t.map(p=>p.n));
      if(duplas.length<2){plano.fases.splice(indiceAtual+1);estado.fases.splice(indiceAtual+1);return;}
      const faseNova={titulo:'Dupla dinâmica',modo:'fila',times:duplas,dinamico:true,rotativo:null};
      plano.fases.splice(indiceAtual+1,plano.fases.length,faseNova);
      estado.fases.splice(indiceAtual+1,estado.fases.length-indiceAtual-1,criarEstadoDaFase(faseNova));
      return;
    }
    if(plano.configuracao.tipo==='trio-rotativo'){
      const jogadores=ativos(), total=jogadores.length*(jogadores.length-1)*(jogadores.length-2)/6;
      const completo=jogadores.length%3===0&&total<=2000;
      const times=completo?gerarCombinacoes(jogadores,3).map(t=>t.map(p=>p.n)):
        (escolherEquipesAoVivo(faseAtual(),2,[],3)?.equipes||[]).map(t=>t.map(p=>p.n));
      if(times.length<2){plano.fases.splice(indiceAtual+1);estado.fases.splice(indiceAtual+1);return;}
      const faseNova={titulo:'Trio rotativo',modo:'fila',times:times,dinamico:true,rotativo:{modo:completo?'completo':'reservas',jogadores:jogadores.map(p=>({...p})),misto:plano.configuracao.misto,cap:plano.configuracao.cap,permanencia:jogadores.length===6?false:plano.configuracao.permanencia,combinacoesCompletas:completo,totalCombinacoes:total}};
      plano.fases.splice(indiceAtual+1,plano.fases.length,faseNova);
      estado.fases.splice(indiceAtual+1,estado.fases.length-indiceAtual-1,criarEstadoDaFase(faseNova));
      return;
    }
    if(plano.configuracao.tipo!=='dupla-rodadas'&&plano.configuracao.tipo!=='trio-fixo'&&plano.configuracao.tipo!=='dupla-fixa') return;
    const tamanho=plano.tamanho, config=plano.configuracao;
    for(let i=indiceAtual+1;i<plano.fases.length;i++){
      const grupos=gruposFixos(ativos(),tamanho,config).map(t=>t.map(p=>p.n));
      if(grupos.length<2){
        plano.fases.splice(i);estado.fases.splice(i);break;
      }
      plano.fases[i]={titulo:'Rodada '+(i+1),modo:'jogo',times:grupos.slice(0,2)};
      estado.fases[i]=criarEstadoDaFase(plano.fases[i]);
    }
  }

  function atualizarProgramacaoAposParticipantes({novoJogo=false}={}){
    const fase=faseAtual();
    if(!fase) return;
    if(fase.mudancaFormatoPendente){
      if(dadosDaFase().modo==='jogo') atualizarFuturasRodadas(estado.faseAtual);
      return;
    }
    const antigoTipo=plano.configuracao.tipo;
    if(dadosDaFase().modo==='jogo'){
      atualizarFuturasRodadas(estado.faseAtual);
      if(ativos().length<4) estado.gestao.mensagem='Não é possível montar partidas futuras com menos de quatro pessoas disponíveis.';
      if(novoJogo) fase.revisaoJogo=(fase.revisaoJogo||0)+1;
      return;
    }
    reconstruirFila(fase,novoJogo||fase.bloqueada);
    if(antigoTipo==='dupla-rodadas'||antigoTipo==='trio-fixo') atualizarFuturasRodadas(estado.faseAtual);
  }

  function solicitarRetornoParaTrio(){
    const config=plano.configuracao;
    if(!config.tipoTrioOriginal||ativos().length<6||String(config.tipo).startsWith('trio-')) return false;
    if(!confirm('Há participantes suficientes para voltar ao formato de trios. Deseja refazer os próximos sorteios em trios?')) return false;
    config.tipo=config.tipoTrioOriginal;
    plano.tamanho=3;plano.unit='Trio';
    const fase=faseAtual();fase.mudancaFormatoPendente=true;
    estado.gestao.mensagem='O jogo atual continua em duplas. Os próximos sorteios voltarão para trios.';
    return true;
  }

  function concluirRetornoParaTrio(){
    const fase=faseAtual();
    if(!fase?.mudancaFormatoPendente) return false;
    delete fase.mudancaFormatoPendente;
    fase.dinamico=plano.configuracao.tipo==='trio-rotativo';
    fase.modo='fila';dadosDaFase().modo='fila';
    reconstruirFila(fase,true);
    estado.gestao.mensagem='Os próximos jogos foram refeitos em trios.';
    return true;
  }

  function substituirAusentesNaPartida(fase,dados){
    if(!['fila','jogo'].includes(dados.modo)) return {substitutos:[],semReserva:[],refez:false};
    const ausentes=new Set(estado.gestao.ausentes.map(chavePessoa));
    const ausentesEmQuadra=fase.quadra.flatMap(id=>dados.times[id]||[]).filter(n=>ausentes.has(chavePessoa(n)));
    if(!ausentesEmQuadra.length) return {substitutos:[],semReserva:[],refez:false};

    const noJogo=new Set(fase.quadra.flatMap(id=>dados.times[id]||[]).map(chavePessoa));
    const reservas=ativos().filter(p=>!noJogo.has(chavePessoa(p.n)))
      .sort((a,b)=>obterStats(b.n).espera-obterStats(a.n).espera
        ||obterStats(a.n).partidas-obterStats(b.n).partidas
        ||Math.random()-.5);
    const tamanho=(dados.times[fase.quadra[0]]||[]).length;
    if(tamanho===3&&(reservas.length<ausentesEmQuadra.length||ativos().length<6)){
      reconstruirFila(fase,true,true);
      return {substitutos:[],semReserva:[],refez:true};
    }

    let proximaReserva=0;
    const substituidos=[],semReserva=[];
    fase.quadra.forEach(id=>{
      const time=dados.times[id].slice();
      time.forEach((nome,posicao)=>{
        if(!ausentes.has(chavePessoa(nome))) return;
        const reserva=reservas[proximaReserva++];
        if(reserva){time[posicao]=reserva.n;substituidos.push({ausente:nome,reserva:reserva.n});}
        else semReserva.push(nome);
      });
      dados.times[id]=time;
    });
    return {substitutos:substituidos,semReserva:semReserva,refez:false};
  }

  function registrarAusencia(indice){
    const participante=normalizarParticipantes()[indice];if(!participante)return;
    guardarParaDesfazer();
    const nome=participante.n,key=chavePessoa(nome),fase=faseAtual(),dados=dadosDaFase();
    if(!estado.gestao.ausentes.some(n=>chavePessoa(n)===key)) estado.gestao.ausentes.push(nome);
    estado.gestao.novosAposJogo=(estado.gestao.novosAposJogo||[]).filter(n=>chavePessoa(n)!==key);
    const resultado=substituirAusentesNaPartida(fase,dados);
    if(!resultado.refez) atualizarProgramacaoAposParticipantes();
    if(ativos().length<4){
      const plural=resultado.semReserva.length>1;
      estado.gestao.mensagem=resultado.semReserva.length
        ?'Sem reservas suficientes para substituir '+resultado.semReserva.join(', ')+'. '+(plural?'Essas pessoas permanecem apenas nesta partida e não contam':'A pessoa permanece apenas nesta partida e não conta')+' no histórico ou ranking. Não é possível montar partidas futuras com menos de quatro pessoas disponíveis.'
        :'Não é possível montar partidas futuras com menos de quatro pessoas disponíveis.';
    }else if(resultado.refez){
      estado.gestao.mensagem='Não foi possível manter dois trios completos; a partida atual foi refeita em duplas.';
    }else if(resultado.semReserva.length){
      const plural=resultado.semReserva.length>1;
      estado.gestao.mensagem='Sem reservas suficientes para substituir '+resultado.semReserva.join(', ')+'. '+(plural?'Essas pessoas permanecem listadas apenas nesta partida; não contam':'A pessoa permanece listada apenas nesta partida; não conta')+' no histórico ou ranking e não entra nos próximos sorteios.';
    }else if(resultado.substitutos.length){
      estado.gestao.mensagem='Ausência coberta: '+resultado.substitutos.map(s=>s.reserva+' entrou no lugar de '+s.ausente).join('; ')+'.';
    }else{
      estado.gestao.mensagem='Ausência registrada. Os próximos sorteios foram refeitos.';
    }
    finalizarAcao();
  }

  function reativarParticipante(indice){
    const participante=normalizarParticipantes()[indice];if(!participante)return;
    guardarParaDesfazer();
    estado.gestao.ausentes=estado.gestao.ausentes.filter(n=>chavePessoa(n)!==chavePessoa(participante.n));
    obterStats(participante.n).espera=0;
    estado.gestao.mensagem='Participante reativado para os próximos sorteios.';
    solicitarRetornoParaTrio();
    atualizarProgramacaoAposParticipantes();
    if(!estado.gestao.mensagem) estado.gestao.mensagem='Participante reativado para os próximos sorteios.';
    finalizarAcao();
  }

  function adicionarParticipante(){
    const campo=$('participantNameNew'), nome=(campo?.value||'').trim();
    if(!nome){alert('Informe o nome da pessoa.');campo?.focus();return;}
    if(normalizarParticipantes().some(p=>chavePessoa(p.n)===chavePessoa(nome))){alert('Essa pessoa já está na competição.');return;}
    const config=plano.configuracao,genero=config.misto?$('participantGenderNew')?.value:null;
    if(config.misto&&!genero){alert('Selecione o grupo da pessoa.');return;}
    guardarParaDesfazer();
    plano.participantes.push({n:nome,g:genero||null});
    estado.gestao.stats[chavePessoa(nome)]={espera:0,partidas:0};
    (estado.gestao.novosAposJogo||(estado.gestao.novosAposJogo=[])).push(chavePessoa(nome));
    solicitarRetornoParaTrio();
    const resultado=substituirAusentesNaPartida(faseAtual(),dadosDaFase());
    if(!resultado.refez) atualizarProgramacaoAposParticipantes();
    if(ativos().length<4){
      estado.gestao.mensagem=resultado.semReserva.length
        ?'Pessoa adicionada, mas ainda não há reservas suficientes para substituir '+resultado.semReserva.join(', ')+'. Não é possível montar partidas futuras com menos de quatro pessoas disponíveis.'
        :'Não é possível montar partidas futuras com menos de quatro pessoas disponíveis.';
    }else if(resultado.refez){
      estado.gestao.mensagem='Pessoa adicionada. Não foi possível manter dois trios; a partida foi refeita em duplas.';
    }else if(resultado.semReserva.length){
      const plural=resultado.semReserva.length>1;
      estado.gestao.mensagem='Pessoa adicionada. '+(plural?'Essas pessoas permanecem listadas':'A pessoa permanece listada')+' apenas nesta partida, sem contar no histórico ou ranking.';
    }else{
      estado.gestao.mensagem='Pessoa adicionada. '+(resultado.substitutos.length
        ?resultado.substitutos.map(s=>s.reserva+' entrou no lugar de '+s.ausente).join('; ')+'.'
        :'Ela entra nos sorteios futuros, após o jogo atual.');
    }
    if(campo)campo.value='';
    finalizarAcao();
  }

  function adicionarTrioAoPlano(fase,pessoas){
    const id=dadosDaFase().times.length;
    dadosDaFase().times.push(pessoas.map(p=>p.n));
    fase.sequencia[id]=1;
    return id;
  }

  function colocarDoisNovosEmQuadra(fase) {
    if(fase.dinamico){
      const novos=retirarDoisCompativeis(fase);
      if(novos){ fase.quadra=novos; novos.forEach(id=>{fase.sequencia[id]=1;}); return; }
    }
    const primeiro = retirarProximoDaFila(fase);
    const segundo = retirarProximoDaFila(fase);
    fase.quadra = [primeiro, segundo];
    fase.sequencia[primeiro] = 1;
    fase.sequencia[segundo] = 1;
  }

  function atualizarFilaDepoisDoJogo(fase, idVencedor, idPerdedor) {
    if(fase.modelo2){atualizarFilaModelo2DepoisDoJogo(fase,idVencedor);return;}
    const rotativo=dadosDaFase().rotativo;
    if(rotativo && rotativo.modo==='reservas'){
      const deveFicar=rotativo.permanencia && fase.sequencia[idVencedor] < JOGOS_SEGUIDOS_MAXIMO;
      if(deveFicar){
        const pessoasVencedoras=dadosDaFase().times[idVencedor];
        const desafiante=escolherEquipesAoVivo(fase,1,pessoasVencedoras,3);
        if(desafiante && desafiante.equipes[0].length===3){
          const idNovo=adicionarTrioAoPlano(fase,desafiante.equipes[0]);
          fase.sequencia[idVencedor]+=1;
          fase.quadra=[idVencedor,idNovo];
          return;
        }
      }
      const novos=escolherEquipesAoVivo(fase,2,[]);
      if(!novos || novos.equipes.length!==2) throw new Error('Não foi possível formar dois trios com os jogadores disponíveis.');
      fase.quadra=novos.equipes.map(time=>adicionarTrioAoPlano(fase,time));
      return;
    }

    if(fase.dinamico){
      fase.fila.push({id:idPerdedor,jogou:true});
      const maximo=rotativo?(rotativo.permanencia?JOGOS_SEGUIDOS_MAXIMO:1):JOGOS_SEGUIDOS_MAXIMO;
      if(fase.sequencia[idVencedor]>=maximo){
        fase.fila.push({id:idVencedor,jogou:true});
        colocarDoisNovosEmQuadra(fase);
      }else{
        const desafiante=retirarProximoCompativel(fase,idVencedor);
        if(desafiante===null){
          fase.fila.push({id:idVencedor,jogou:true});
          colocarDoisNovosEmQuadra(fase);
        }else{
          fase.sequencia[idVencedor]+=1;
          fase.sequencia[desafiante]=1;
          fase.quadra=[idVencedor,desafiante];
        }
      }
      return;
    }

    fase.fila.push({ id: idPerdedor, jogou: true });            // quem perde vai para o fim

    const maximo=rotativo ? (rotativo.permanencia ? JOGOS_SEGUIDOS_MAXIMO : 1) : JOGOS_SEGUIDOS_MAXIMO;
    if (fase.sequencia[idVencedor] >= maximo) {
      // o vencedor já usou a partida adicional: também sai, atrás de quem perdeu
      fase.fila.push({ id: idVencedor, jogou: true });
      colocarDoisNovosEmQuadra(fase);
    } else if(rotativo){
      const desafiante=retirarProximoCompativel(fase,idVencedor);
      if(desafiante===null){
        fase.fila.push({id:idVencedor,jogou:true});
        colocarDoisNovosEmQuadra(fase);
      }else{
        fase.sequencia[idVencedor]+=1;
        fase.sequencia[desafiante]=1;
        fase.quadra=[idVencedor,desafiante];
      }
    }else {
      // o vencedor fica e enfrenta o próximo da fila
      const desafiante = retirarProximoDaFila(fase);
      fase.sequencia[idVencedor] += 1;
      fase.sequencia[desafiante] = 1;
      fase.quadra = [idVencedor, desafiante];
    }
  }

  // ---------- ações do usuário ----------
  function registrarVitoria(idVencedor) {
    guardarParaDesfazer();
    const fase = faseAtual();
    const dados = dadosDaFase();
    const idPerdedor = (idVencedor === fase.quadra[0]) ? fase.quadra[1] : fase.quadra[0];
    const ausentesNaPartida=new Set(estado.gestao.ausentes.map(chavePessoa));
    const vencedoresPresentes=(dados.times[idVencedor]||[]).filter(nome=>!ausentesNaPartida.has(chavePessoa(nome)));
    const perdedoresPresentes=(dados.times[idPerdedor]||[]).filter(nome=>!ausentesNaPartida.has(chavePessoa(nome)));
    const textoTime=nomes=>nomes.length?nomes.join(' + '):'sem participantes presentes';

    fase.jogos += 1;
    estado.historico.push({
      titulo: dados.titulo,
      numero: fase.jogos,
      vencedor: textoTime(vencedoresPresentes),        // ausentes mantidos como referência visual não contam no histórico
      perdedor: textoTime(perdedoresPresentes),
      vencedores: vencedoresPresentes,                 // usados pelo ranking
      perdedores: perdedoresPresentes
    });

    atualizarEspera(fase);
    estado.gestao.novosAposJogo=[];

    if(ativos().length<4){
      fase.bloqueada=true;fase.fila=[];
      estado.gestao.mensagem='Resultado registrado. Não é possível montar novas partidas com menos de quatro pessoas disponíveis.';
      finalizarAcao();return;
    }
    estado.gestao.mensagem='';

    if(fase.mudancaFormatoPendente&&dados.modo==='fila'){
      reconstruirFila(fase,true);
      delete fase.mudancaFormatoPendente;
    } else if (dados.modo === 'jogo') {
      fase.vencedor = idVencedor;
      if(fase.mudancaFormatoPendente){
        // Ao voltar a trios, a partida atual termina em duplas e o próximo jogo é refeito.
        estado.faseAtual=Math.min(estado.faseAtual+1,plano.fases.length-1);
      }else if (estado.faseAtual < plano.fases.length - 1) estado.faseAtual += 1;
    } else {
      atualizarFilaDepoisDoJogo(fase, idVencedor, idPerdedor);
      if(fase.mudancaFormatoPendente) concluirRetornoParaTrio();
    }
    finalizarAcao();
  }

  function processarPedidoDeEncerramento(pedido) {
    if (!pedido || !estado || !plano || !faseAtual()) return false;
    const fase = faseAtual();
    const correspondeAoJogo = plano.id === pedido.planoId
      && estado.faseAtual === pedido.faseAtual
      && (fase.jogos || 0) === pedido.jogos
      && JSON.stringify(fase.quadra) === JSON.stringify(pedido.quadra);
    if (!correspondeAoJogo || !fase.quadra.includes(pedido.idVencedor)) return false;
    registrarVitoria(pedido.idVencedor);
    try {
      if (JSON.parse(ArmazenamentoLocal.getItem(CHAVE_PEDIDO_PLACAR) || 'null')?.id === pedido.id) {
        ArmazenamentoLocal.removeItem(CHAVE_PEDIDO_PLACAR);
      }
    } catch (erro) {}
    return true;
  }

  function processarPedidoPendente() {
    try {
      if ((!estado || !plano) && !carregar()) return false;
      const pedido = JSON.parse(ArmazenamentoLocal.getItem(CHAVE_PEDIDO_PLACAR) || 'null');
      return processarPedidoDeEncerramento(pedido);
    } catch (erro) {
      return false;
    }
  }
  function alternarJaJogou(id) {
    guardarParaDesfazer();
    const item = faseAtual().fila.find(i => i.id === id);
    if (item) item.jogou = !item.jogou;
    finalizarAcao();
  }

  function pularParaOFim(id) {
    guardarParaDesfazer();
    const fila = faseAtual().fila;
    const posicao = fila.findIndex(i => i.id === id);
    if (posicao >= 0) {
      const item = fila.splice(posicao, 1)[0];
      item.jogou = false;
      fila.push(item);
    }
    finalizarAcao();
  }

  function mudarRodada(passo) {
    const nova = estado.faseAtual + passo;
    if (nova < 0 || nova >= plano.fases.length) return;
    estado.faseAtual = nova;
    finalizarAcao();
  }

  // ---------- ranking ----------
  function calcularRanking() {
    const tabela = {};
    function contar(nomes, venceu) {
      nomes.forEach(nome => {
        if (!tabela[nome]) tabela[nome] = { nome: nome, vitorias: 0, jogos: 0 };
        tabela[nome].jogos += 1;
        if (venceu) tabela[nome].vitorias += 1;
      });
    }
    estado.historico.forEach(jogo => {
      contar(jogo.vencedores || [], true);
      contar(jogo.perdedores || [], false);
    });
    return Object.keys(tabela).map(nome => tabela[nome]).sort((a, b) =>
      b.vitorias - a.vitorias || a.jogos - b.jogos || a.nome.localeCompare(b.nome, 'pt-BR'));
  }
    // texto de uma linha do ranking (usado na tela, no copiar e no PDF)
  function textoDaLinhaDoRanking(jogador, posicao) {
    const sufixo = jogador.vitorias === 1 ? ' vitória' : ' vitórias';
    return (posicao + 1) + '. ' + jogador.nome + ' - ' + jogador.vitorias + sufixo + ' em ' + jogador.jogos + ' jogo(s)';
  }

  // ranking completo em texto, com os filtros do sorteio e a assinatura do app
  function textoDoRanking() {
    const filtros = linhasDoSorteio.find(linha => linha[0] === 'm' && linha[1].indexOf('Filtros') === 0);
    const linhas = ['Ranking de vitórias'];
    if (filtros) linhas.push(filtros[1]);
    linhas.push('');
    calcularRanking().forEach((jogador, posicao) => linhas.push(textoDaLinhaDoRanking(jogador, posicao)));
    linhas.push('', 'Gerado pelo app BolleyVall Placar em ' + new Date().toLocaleString('pt-BR'));
    return linhas.join('\n');
  }

  function copiarPeloMetodoAntigo(texto, aoCopiar) {
    const campo = document.createElement('textarea');
    campo.value = texto;
    document.body.appendChild(campo);
    campo.select();
    document.execCommand('copy');
    campo.remove();
    aoCopiar();
  }

  function copiarRanking(botao) {
    const texto = textoDoRanking();
    const mostrarConfirmacao = () => {
      const original = botao.textContent;
      botao.textContent = 'Copiado!';
      setTimeout(() => { botao.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(mostrarConfirmacao, () => copiarPeloMetodoAntigo(texto, mostrarConfirmacao));
    } else {
      copiarPeloMetodoAntigo(texto, mostrarConfirmacao);
    }
  }

  function gerarPdfDoRanking() {
    if (!window.jspdf) {
      alert('Não foi possível carregar a biblioteca de PDF. Verifique a conexão e tente de novo.');
      return;
    }
    const documento = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
    const linhas = textoDoRanking().split('\n');
    let y = 20;

    linhas.forEach((linha, indice) => {
      const ehTitulo = indice === 0;
      const ehRodape = indice === linhas.length - 1;
      const ehFiltro = linha.indexOf('Filtros') === 0;
      if (!linha) { y += 5; return; }

      documento.setFont('helvetica', ehTitulo ? 'bold' : ehRodape ? 'italic' : 'normal');
      documento.setFontSize(ehTitulo ? 18 : (ehRodape || ehFiltro) ? 9 : 11);
      documento.setTextColor((ehRodape || ehFiltro) ? 110 : 0);

      documento.splitTextToSize(linha, 174).forEach(parte => {
        if (y > 282) { documento.addPage(); y = 20; }
        documento.text(parte, 18, y);
        y += ehTitulo ? 10 : 6;
      });
    });
    documento.save('ranking-bolleyvall.pdf');
  }

  // ---------- desenho da tela ----------
  function criar(tag, classe, texto, atributos) {
    const elemento = document.createElement(tag);
    if (classe) elemento.className = classe;
    if (texto !== undefined) elemento.textContent = texto;
    if (atributos) {
      Object.keys(atributos).forEach(nome => elemento.setAttribute(nome, atributos[nome]));
    }
    return elemento;
  }

  function criarBotao(classe, texto, acao, id) {
    const botao = criar('button', classe, texto, { type: 'button', 'data-acao': acao });
    if (id !== undefined) botao.setAttribute('data-id', id);
    return botao;
  }

  function renderizar() {
    const raiz = $('tracker');
    if (!raiz) return;
    if (!estado) { raiz.hidden = true; return; }
    raiz.hidden = false;
    renderizarQuadra();
    renderizarFila();
    renderizarParticipantes();
    renderizarHistorico();
    renderizarRanking();
  }

  function linhaDoTimeEmQuadra(id, fase, dados) {
    const linha = criar('div', 'linha');
    const nome = criar('div', 'nome', descricao(id));

    if (timeIncompleto(id)) nome.appendChild(criar('div', 'etiqueta', 'INCOMPLETO'));

    const permanenciaModelo2=fase.modelo2?.permanencia;
    const saiDepois=dados.rotativo
      ? (!dados.rotativo.permanencia || fase.sequencia[id] >= JOGOS_SEGUIDOS_MAXIMO)
      : fase.modelo2
        ? (!permanenciaModelo2 || fase.sequencia[id] >= JOGOS_SEGUIDOS_MAXIMO)
      : fase.sequencia[id] >= JOGOS_SEGUIDOS_MAXIMO;
    if (dados.modo === 'fila' && saiDepois) {
      nome.appendChild(criar('div', 'etiqueta', 'SAI APÓS ESTE JOGO'));
    }
    
    linha.appendChild(nome);

    const jogoJaDecidido = dados.modo === 'jogo' && fase.vencedor !== null;
    if (!jogoJaDecidido && !fase.bloqueada) {
      linha.appendChild(criarBotao('btn-venceu', 'Venceu', 'venceu', id));
    } else if (fase.vencedor === id) {
      linha.appendChild(criar('span', 'etiqueta destaque', 'VENCEU'));
    }
    return linha;
  }

  function renderizarQuadra() {
    const caixa = $('trackerQuadra');
    caixa.innerHTML = '';
    const fase = faseAtual();
    const dados = dadosDaFase();
    const totalDeFases = plano.fases.length;

    let titulo = 'Na quadra · ' + dados.titulo;
    if (totalDeFases > 1) titulo += ' (' + (estado.faseAtual + 1) + ' de ' + totalDeFases + ')';
    if (dados.modo === 'fila') titulo += ' · Jogo ' + (fase.jogos + 1);
    caixa.appendChild(criar('h2', '', titulo));

    caixa.appendChild(linhaDoTimeEmQuadra(fase.quadra[0], fase, dados));
    caixa.appendChild(criar('div', 'vs', 'vs.'));
    caixa.appendChild(linhaDoTimeEmQuadra(fase.quadra[1], fase, dados));

    const controles = criar('div', 'linha');
    const desfazer = criarBotao('btn-mini', 'Desfazer', 'desfazer');
    desfazer.disabled = estado.desfazer.length === 0;
    controles.appendChild(desfazer);

    if (totalDeFases > 1) {
      const anterior = criarBotao('btn-mini', '‹ Rodada anterior', 'rodada-anterior');
      anterior.disabled = estado.faseAtual === 0;
      const proxima = criarBotao('btn-mini', 'Próxima rodada ›', 'rodada-proxima');
      proxima.disabled = estado.faseAtual === totalDeFases - 1;
      const grupo = criar('div', 'grupo-botoes');
      grupo.appendChild(anterior);
      grupo.appendChild(proxima);
      controles.appendChild(grupo);
    }
    caixa.appendChild(controles);

    const linhaCompartilhar = criar('div', 'linha');
    const botaoCompartilhar = criarBotao('btn-mini', 'Compartilhar andamento', 'compartilhar-andamento');
    botaoCompartilhar.style.flex = '1';
    linhaCompartilhar.appendChild(botaoCompartilhar);
    caixa.appendChild(linhaCompartilhar);

    if(!fase.bloqueada&&estado.gestao.mensagem&&(estado.gestao.mensagem.startsWith('Não é possível montar')||estado.gestao.mensagem.startsWith('Sem reservas suficientes')||estado.gestao.mensagem.startsWith('Não foi possível manter dois trios'))){
      caixa.appendChild(criar('div','err',estado.gestao.mensagem));
    }

    if(fase.bloqueada){
      caixa.appendChild(criar('div','err',estado.gestao.mensagem||'Não é possível montar partidas com menos de quatro pessoas disponíveis. Reative ou adicione participantes para continuar.'));
      return;
    }

    if (dados.modo === 'fila') {
      const explicacao=fase.modelo2
        ? (fase.modelo2.permanencia?((fase.modelo2.tamanho===3?'O trio':'A dupla')+' vencedor permanece por mais uma partida e depois sai da quadra.'):((fase.modelo2.tamanho===3?'O trio':'A dupla')+' vencedor sai da quadra após cada partida.'))
        : dados.rotativo
        ? (dados.rotativo.permanencia ? 'O trio vencedor permanece por mais uma partida e depois sai da quadra.' : 'O trio vencedor sai da quadra após cada partida.')
        : 'O vencedor fica no máximo mais 1 jogo; quem perde vai para o fim da fila';
      caixa.appendChild(criar('div', 'etiqueta', explicacao));
    }
  }

  function renderizarFila() {
    const caixa = $('trackerFila');
    if(filaObserver){ filaObserver.disconnect(); filaObserver=null; }
    caixa.innerHTML = '';
    if (dadosDaFase().modo === 'jogo') { caixa.hidden = true; return; }
    caixa.hidden = false;
    caixa.appendChild(criar('h2', '', 'Fila'));

    const fase = faseAtual();
    const configRotativa=dadosDaFase().rotativo;
    if(fase.modelo2){
      caixa.appendChild(criar('div','small','Modelo 2 · a fila é formada durante os jogos, priorizando quem está há mais tempo sem jogar.'));
      if(fase.fila.length===0){
        caixa.appendChild(criar('div','etiqueta','AGUARDANDO O FIM DA PARTIDA PARA FORMAR OS PRÓXIMOS TIMES'));
        return;
      }
    }
    if(configRotativa && configRotativa.modo==='reservas'){
      caixa.appendChild(criar('div','small','Reservas · quem está há mais tempo sem jogar entra primeiro.'));
      const emQuadra=new Set(fase.quadra.flatMap(id=>dadosDaFase().times[id]||[]).map(chavePessoa));
      const pessoas=configRotativa.jogadores.filter(p=>!emQuadra.has(chavePessoa(p.n))).slice().sort((a,b)=>{
        const ka=chavePessoa(a.n),kb=chavePessoa(b.n);
        return (fase.rotativoEstado.espera[kb]||0)-(fase.rotativoEstado.espera[ka]||0)
          || (fase.rotativoEstado.partidas[ka]||0)-(fase.rotativoEstado.partidas[kb]||0);
      });
      pessoas.forEach((p,i)=>{
        const linha=criar('div','linha'+(i<3?' proximo':''));
        linha.appendChild(criar('div','nome',p.n));
        const espera=fase.rotativoEstado.espera[chavePessoa(p.n)]||0;
        linha.appendChild(criar('span','etiqueta',espera+' jogo(s) aguardando'));
        caixa.appendChild(linha);
      });
      return;
    }
    if (fase.fila.length === 0) {
      caixa.appendChild(criar('div', 'etiqueta', 'FILA VAZIA'));
      return;
    }

    const idProximo = idDoProximo(fase);
    const todosJaJogaram = fase.fila.every(item => item.jogou);   // nova volta: ninguém aparece riscado
    

    const visiveis=configRotativa ? fase.fila.slice(0,fase.filaVisivel||20) : fase.fila;
    visiveis.forEach(item => {
      let classe = 'linha';
      if (item.id === idProximo) classe += ' proximo';
      if (item.jogou && !todosJaJogaram) classe += ' jogou';
      const linha = criar('div', classe);

      const nome = criar('div', 'nome', descricao(item.id));
      if (item.id === idProximo) nome.appendChild(criar('div', 'etiqueta destaque', 'PRÓXIMO'));
      if (timeIncompleto(item.id)) nome.appendChild(criar('div', 'etiqueta', 'INCOMPLETO'));     
      linha.appendChild(nome);

      const grupo = criar('div', 'grupo-botoes');
      grupo.appendChild(criarBotao('btn-mini', item.jogou ? 'Desmarcar' : 'Já jogou', 'jogou', item.id));
      grupo.appendChild(criarBotao('btn-mini', 'Pular', 'pular', item.id));
      linha.appendChild(grupo);
      caixa.appendChild(linha);
    });
    if(configRotativa && visiveis.length<fase.fila.length){
      const sentinela=criar('div','small','Role até o fim para carregar os próximos trios.');
      caixa.appendChild(sentinela);
      if('IntersectionObserver' in window){
        filaObserver=new IntersectionObserver(entries=>{
          if(entries.some(e=>e.isIntersecting)){
            fase.filaVisivel=Math.min(fase.fila.length,(fase.filaVisivel||20)+20);
            renderizar();
          }
        },{rootMargin:'120px'});
        filaObserver.observe(sentinela);
      }
    }
  }

  function renderizarHistorico() {
    const caixa = $('trackerHistorico');
    caixa.innerHTML = '';
    caixa.appendChild(criar('h2', '', 'Histórico'));

    if (estado.historico.length === 0) {
      caixa.appendChild(criar('div', 'etiqueta', 'NENHUM JOGO REGISTRADO AINDA'));
      return;
    }
    const comTitulo = plano.fases.length > 1;
    estado.historico.forEach(jogo => {
      const prefixo = comTitulo ? jogo.titulo + ' · ' : '';
      caixa.appendChild(criar('div', 'texto-linha',
        prefixo + 'Jogo ' + jogo.numero + ': ' + jogo.vencedor + ' VENCEU ' + jogo.perdedor));
    });
  }

  function renderizarParticipantes(){
    const caixa=$('trackerParticipants');
    if(!caixa) return;
    const participantes=normalizarParticipantes();
    caixa.hidden=!participantes.length;
    if(!participantes.length) return;
    $('participantList').innerHTML='';
    $('participantGenderRow').hidden=!plano.configuracao.misto;
    $('participantStatus').textContent=estado.gestao.mensagem||'Ausências, reativações e novas entradas alteram apenas os próximos sorteios, salvo quando não houver trios possíveis.';
    const ausentes=new Set(estado.gestao.ausentes.map(chavePessoa));
    participantes.forEach((p,i)=>{
      const linha=criar('div','linha');
      const nome=criar('div','nome',p.n+(ausentes.has(chavePessoa(p.n))?' · ausente':''));
      linha.appendChild(nome);
      linha.appendChild(criarBotao('btn-mini',ausentes.has(chavePessoa(p.n))?'Reativar':'Marcar ausência',ausentes.has(chavePessoa(p.n))?'reativar-participante':'ausentar-participante',i));
      $('participantList').appendChild(linha);
    });
  }

  function renderizarRanking() {
    const caixa = $('trackerRanking');
    caixa.innerHTML = '';
    caixa.appendChild(criar('h2', '', 'Ranking de vitórias'));

    const ranking = calcularRanking();
    if (ranking.length === 0) {
      caixa.appendChild(criar('div', 'etiqueta', 'AINDA SEM RESULTADOS'));
      return;
    }
    ranking.forEach((jogador, posicao) => {
      caixa.appendChild(criar('div', 'texto-linha', textoDaLinhaDoRanking(jogador, posicao)));
    });

    const acoes = criar('div', 'grupo-botoes');
    acoes.style.marginTop = '8px';
    acoes.appendChild(criarBotao('btn-mini', 'Copiar ranking', 'copiar-ranking'));
    acoes.appendChild(criarBotao('btn-mini', 'PDF do ranking', 'pdf-ranking'));
    caixa.appendChild(acoes);
  }

  // ---------- cliques ----------
  document.addEventListener('click', evento => {
    const botao = evento.target.closest('[data-acao]');
    if (!botao || !estado) return;
    const id = Number(botao.getAttribute('data-id'));

    switch (botao.getAttribute('data-acao')) {
      case 'venceu':           registrarVitoria(id); break;
      case 'jogou':            alternarJaJogou(id); break;
      case 'pular':            pularParaOFim(id); break;
      case 'desfazer':         desfazerUltimaAcao(); break;
      case 'rodada-anterior':  mudarRodada(-1); break;
      case 'rodada-proxima':   mudarRodada(1); break;
      case 'copiar-ranking':   copiarRanking(botao); break;
      case 'pdf-ranking':      gerarPdfDoRanking(); break;
      case 'compartilhar-andamento':  Compartilhar.compartilharAndamento(botao); break;
      case 'ausentar-participante': registrarAusencia(id); break;
      case 'reativar-participante': reativarParticipante(id); break;
      case 'adicionar-participante': adicionarParticipante(); break;
    }
  });

  // devolve o sorteio atual (sem o andamento), usado para gerar o link de compartilhamento
  // devolve o sorteio atual (sem o andamento), usado para gerar o link de compartilhamento
  function obterSorteio() {
    return plano ? { plano: plano, linhas: linhasDoSorteio, formulario: formularioDoSorteio } : null;
  }

  function obterAndamento() {
    if (!estado) return null;
    return {
      geradoEm: Date.now(),
      estado: { faseAtual: estado.faseAtual, fases: estado.fases, historico: estado.historico }
    };
  }

  // abre um sorteio recebido já no ponto em que a outra pessoa parou
  function iniciarComAndamento(novoPlano, linhas, formulario, andamento) {
    plano = novoPlano;
    if (!plano.id) plano.id = gerarIdPlano();
    linhasDoSorteio = linhas;
    formularioDoSorteio = formulario || null;
    estado = andamento.estado;      // já validado e com a pilha de desfazer vazia
    if(!estado.gestao) estado.gestao=inicializarGestao();
    normalizarStatsGestao();
    salvar();
    renderizar();
  }

  function quantidadeDeJogos() {
    return estado ? estado.historico.length : 0;
  }

  function trocarLados() {
    if (!estado || !plano) return false;
    const fase = faseAtual();
    if (!Array.isArray(fase?.quadra) || fase.quadra.length !== 2) return false;
    [fase.quadra[0], fase.quadra[1]] = [fase.quadra[1], fase.quadra[0]];
    salvar();
    renderizar();
    return true;
  }
    ArmazenamentoLocal.subscribe(evento => {
    if (evento.key === CHAVE_STORAGE) {
      carregar();
      return;
    }
    if (evento.key !== CHAVE_PEDIDO_PLACAR || !evento.newValue) return;
    try {
      const pedido = JSON.parse(evento.newValue);
      if (carregar()) processarPedidoDeEncerramento(pedido);
    } catch (erro) {}
  });

  return {
    iniciar: iniciar,
    carregar: carregar,
    temProgresso: temProgresso,
    obterSorteio: obterSorteio,
    obterAndamento: obterAndamento,
    iniciarComAndamento: iniciarComAndamento,
    quantidadeDeJogos: quantidadeDeJogos,
    trocarLados: trocarLados,
    processarPedidoPendente: processarPedidoPendente
  };

})();
window.Fila = Fila;
