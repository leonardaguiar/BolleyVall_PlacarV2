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
  const chavePessoa = nome => String(nome).toLocaleLowerCase('pt-BR');

  function criarEsperaRotativa(config,quadra,times){
    if(!config || config.modo!=='reservas') return null;
    const emQuadra=new Set(quadra.flatMap(id=>times[id]||[]).map(chavePessoa));
    const espera={}, partidas={};
    config.jogadores.forEach(p=>{
      const chave=chavePessoa(p.n);
      espera[chave]=emQuadra.has(chave) ? 0 : 1;
      partidas[chave]=emQuadra.has(chave) ? 1 : 0;
    });
    return {espera:espera,partidas:partidas};
  }

  // ---------- criação do estado ----------
  function criarEstadoDaFase(fase) {
    const ids = fase.times.map((_, indice) => indice);
    const sequencia = {};
    sequencia[ids[0]] = 1;
    sequencia[ids[1]] = 1;
      window.addEventListener('storage', evento => {
    if (evento.key !== CHAVE_PEDIDO_PLACAR || !evento.newValue) return;
    try {
      const pedido = JSON.parse(evento.newValue);
      if (carregar()) processarPedidoDeEncerramento(pedido);
    } catch (erro) {}
  });
return {
      quadra: [ids[0], ids[1]],                               // os dois primeiros jogam
      fila: ids.slice(2).map(id => ({ id: id, jogou: false })),
      sequencia: sequencia,                                   // jogos seguidos de cada time em quadra
      jogos: 0,
      vencedor: null,                                         // só usado no modo 'jogo'
      filaVisivel: 20,
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
      desfazer: []
    };
    salvar();
    renderizar();
  }

  function carregar() {
    try {
      const bruto = localStorage.getItem(CHAVE_STORAGE);
      if (!bruto) return null;
      const salvo = JSON.parse(bruto);
      plano = salvo.plano;
      if (!plano.id) plano.id = gerarIdPlano();
      estado = salvo.estado;
      linhasDoSorteio = salvo.linhas;
      formularioDoSorteio = salvo.formulario || null;
      renderizar();
        window.addEventListener('storage', evento => {
    if (evento.key !== CHAVE_PEDIDO_PLACAR || !evento.newValue) return;
    try {
      const pedido = JSON.parse(evento.newValue);
      if (carregar()) processarPedidoDeEncerramento(pedido);
    } catch (erro) {}
  });
return { linhas: salvo.linhas, formulario: formularioDoSorteio };
    } catch (erro) {
      return null;
    }
  }

  function salvar() {
    try {
      localStorage.setItem(CHAVE_STORAGE, JSON.stringify({
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
      historico: estado.historico
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

  function escolherEquipesAoVivo(fase,quantas,foraDaQuadra){
    const config=dadosDaFase().rotativo, estadoEspera=fase.rotativoEstado;
    const excluidos=new Set((foraDaQuadra||[]).map(chavePessoa));
    const restantes=config.jogadores.filter(p=>!excluidos.has(chavePessoa(p)));
    const prioridade=p=>{
      const k=chavePessoa(p.n);
      return (estadoEspera.espera[k]||0)*100-(estadoEspera.partidas[k]||0)*4;
    };
    const empatados=list=>list.map(p=>({p:p,t:Math.random()})).sort((a,b)=>prioridade(b.p)-prioridade(a.p)||a.t-b.t).map(x=>x.p);
    const homens=empatados(restantes.filter(p=>p.g==='M'));
    const mulheres=empatados(restantes.filter(p=>p.g==='F'));
    if(!config.misto){
      const selecionados=empatados(restantes).slice(0,quantas*3);
      if(selecionados.length<quantas*3) return null;
      const embaralhados=selecionados.sort(()=>Math.random()-.5);
      return {equipes:Array.from({length:quantas},(_,i)=>embaralhados.slice(i*3,i*3+3))};
    }

    function montar(cap,relaxado){
      const opcoes=[];
      const buscar=(atuais)=>{
        if(atuais.length===quantas){
          const totalM=atuais.reduce((a,b)=>a+b,0),totalF=quantas*3-totalM;
          if(totalM>homens.length||totalF>mulheres.length) return;
          if(cap){
            if(cap.exact&&!relaxado&&atuais.some(n=>n!==cap.N)) return;
            if(!cap.exact&&atuais.some(n=>n>cap.N)) return;
            if(cap.exact&&relaxado&&atuais.some(n=>n>cap.N)) return;
          }
          const ms=homens.slice(0,totalM),fs=mulheres.slice(0,totalF),equipes=[];
          let mi=0,fi=0,score=0;
          atuais.forEach(n=>{
            const equipe=[...ms.slice(mi,mi+n),...fs.slice(fi,fi+3-n)];
            mi+=n; fi+=3-n;
            score+=equipe.reduce((s,p)=>s+prioridade(p),0);
            if(equipe.some(p=>p.g==='M')&&equipe.some(p=>p.g==='F')) score+=config.misto?200:0;
            equipes.push(equipe);
          });
          if(quantas===2){
            const esperas=equipes.map(t=>t.reduce((s,p)=>s+(estadoEspera.espera[chavePessoa(p.n)]||0),0));
            score-=Math.abs(esperas[0]-esperas[1])*2;
          }
          opcoes.push({equipes,score:score+Math.random()});
          return;
        }
        for(let n=0;n<=3;n++){
          if(cap&&!relaxado&&cap.exact&&n!==cap.N) continue;
          if(cap&&(!cap.exact||relaxado)&&n>cap.N) continue;
          atuais.push(n); buscar(atuais); atuais.pop();
        }
      };
      buscar([]);
      return opcoes.sort((a,b)=>b.score-a.score)[0]||null;
    }
    return montar(config.cap,false)|| (config.cap&&config.cap.exact ? montar({...config.cap,exact:false},true) : null) || montar(null,true);
  }

  function atualizarEspera(fase){
    const config=dadosDaFase().rotativo, estadoEspera=fase.rotativoEstado;
    const emQuadra=new Set(fase.quadra.flatMap(id=>dadosDaFase().times[id]||[]).map(chavePessoa));
    config.jogadores.forEach(p=>{
      const k=chavePessoa(p.n);
      if(emQuadra.has(k)){ estadoEspera.espera[k]=0; estadoEspera.partidas[k]=(estadoEspera.partidas[k]||0)+1; }
      else estadoEspera.espera[k]=(estadoEspera.espera[k]||0)+1;
    });
  }

  function adicionarTrioAoPlano(fase,pessoas){
    const id=dadosDaFase().times.length;
    dadosDaFase().times.push(pessoas.map(p=>p.n));
    fase.sequencia[id]=1;
    return id;
  }

  function colocarDoisNovosEmQuadra(fase) {
    if(dadosDaFase().rotativo){
      const novos=retirarDoisCompativeis(fase);
      if(novos){ fase.quadra=novos; novos.forEach(id=>{fase.sequencia[id]=1;}); return; }
      if(dadosDaFase().rotativo.modo==='reservas'){
        const equipes=escolherEquipesAoVivo(fase,2,[]);
        if(equipes){ fase.quadra=equipes.equipes.map(time=>adicionarTrioAoPlano(fase,time)); return; }
      }
    }
    const primeiro = retirarProximoDaFila(fase);
    const segundo = retirarProximoDaFila(fase);
    fase.quadra = [primeiro, segundo];
    fase.sequencia[primeiro] = 1;
    fase.sequencia[segundo] = 1;
  }

  function atualizarFilaDepoisDoJogo(fase, idVencedor, idPerdedor) {
    const rotativo=dadosDaFase().rotativo;
    if(rotativo && rotativo.modo==='reservas'){
      atualizarEspera(fase);
      const deveFicar=rotativo.permanencia && fase.sequencia[idVencedor] < JOGOS_SEGUIDOS_MAXIMO;
      if(deveFicar){
        const pessoasVencedoras=dadosDaFase().times[idVencedor];
        const desafiante=escolherEquipesAoVivo(fase,1,pessoasVencedoras);
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

    fase.jogos += 1;
    estado.historico.push({
      titulo: dados.titulo,
      numero: fase.jogos,
      vencedor: dados.times[idVencedor].join(' + '),   // texto mostrado no histórico
      perdedor: dados.times[idPerdedor].join(' + '),
      vencedores: dados.times[idVencedor],             // lista de nomes, usada no ranking
      perdedores: dados.times[idPerdedor]
    });

    if (dados.modo === 'jogo') {
      fase.vencedor = idVencedor;
      if (estado.faseAtual < plano.fases.length - 1) estado.faseAtual += 1;   // segue para a próxima rodada
    } else {
      atualizarFilaDepoisDoJogo(fase, idVencedor, idPerdedor);
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
      if (JSON.parse(localStorage.getItem(CHAVE_PEDIDO_PLACAR) || 'null')?.id === pedido.id) {
        localStorage.removeItem(CHAVE_PEDIDO_PLACAR);
      }
    } catch (erro) {}
    return true;
  }

  function processarPedidoPendente() {
    try {
      if ((!estado || !plano) && !carregar()) return false;
      const pedido = JSON.parse(localStorage.getItem(CHAVE_PEDIDO_PLACAR) || 'null');
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
    renderizarHistorico();
    renderizarRanking();
  }

  function linhaDoTimeEmQuadra(id, fase, dados) {
    const linha = criar('div', 'linha');
    const nome = criar('div', 'nome', descricao(id));

    if (timeIncompleto(id)) nome.appendChild(criar('div', 'etiqueta', 'INCOMPLETO'));

    const saiDepois=dados.rotativo
      ? (!dados.rotativo.permanencia || fase.sequencia[id] >= JOGOS_SEGUIDOS_MAXIMO)
      : fase.sequencia[id] >= JOGOS_SEGUIDOS_MAXIMO;
    if (dados.modo === 'fila' && saiDepois) {
      nome.appendChild(criar('div', 'etiqueta', 'SAI APÓS ESTE JOGO'));
    }
    
    linha.appendChild(nome);

    const jogoJaDecidido = dados.modo === 'jogo' && fase.vencedor !== null;
    if (!jogoJaDecidido) {
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

    if (dados.modo === 'fila') {
      const explicacao=dados.rotativo
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
      sentinela.setAttribute('data-fila-sentinela','true');
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
    }
  });

  // devolve o sorteio atual (sem o andamento), usado para gerar o link de compartilhamento
  function obterSorteio() {
    return plano ? { plano: plano, linhas: linhasDoSorteio } : null;
  }

  // devolve o sorteio atual (sem o andamento), usado para gerar o link de compartilhamento
  function obterSorteio() {
    return plano ? { plano: plano, linhas: linhasDoSorteio, formulario: formularioDoSorteio } : null;
  }

  function obterAndamento() {
    if (!estado) return null;
      window.addEventListener('storage', evento => {
    if (evento.key !== CHAVE_PEDIDO_PLACAR || !evento.newValue) return;
    try {
      const pedido = JSON.parse(evento.newValue);
      if (carregar()) processarPedidoDeEncerramento(pedido);
    } catch (erro) {}
  });
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
    salvar();
    renderizar();
  }

  function quantidadeDeJogos() {
    return estado ? estado.historico.length : 0;
  }

  function trocarLados() {
    if (!estado) return false;
    const fase = faseAtual();
    if (!Array.isArray(fase?.quadra) || fase.quadra.length !== 2) return false;
    [fase.quadra[0], fase.quadra[1]] = [fase.quadra[1], fase.quadra[0]];
    salvar();
    renderizar();
    return true;
  }

  window.addEventListener('storage', evento => {
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
