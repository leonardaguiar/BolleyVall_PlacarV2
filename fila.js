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
      vencedor: null                                          // só usado no modo 'jogo'
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

  function colocarDoisNovosEmQuadra(fase) {
    const primeiro = retirarProximoDaFila(fase);
    const segundo = retirarProximoDaFila(fase);
    fase.quadra = [primeiro, segundo];
    fase.sequencia[primeiro] = 1;
    fase.sequencia[segundo] = 1;
  }

  function atualizarFilaDepoisDoJogo(fase, idVencedor, idPerdedor) {
    fase.fila.push({ id: idPerdedor, jogou: true });            // quem perde vai para o fim

    if (fase.sequencia[idVencedor] >= JOGOS_SEGUIDOS_MAXIMO) {
      // o vencedor já usou a partida adicional: também sai, atrás de quem perdeu
      fase.fila.push({ id: idVencedor, jogou: true });
      colocarDoisNovosEmQuadra(fase);
    } else {
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

    if (dados.modo === 'fila' && fase.sequencia[id] >= JOGOS_SEGUIDOS_MAXIMO) {
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
      caixa.appendChild(criar('div', 'etiqueta',
        'O vencedor fica no máximo mais 1 jogo; quem perde vai para o fim da fila'));
    }
  }

  function renderizarFila() {
    const caixa = $('trackerFila');
    caixa.innerHTML = '';
    if (dadosDaFase().modo === 'jogo') { caixa.hidden = true; return; }
    caixa.hidden = false;
    caixa.appendChild(criar('h2', '', 'Fila'));

    const fase = faseAtual();
    if (fase.fila.length === 0) {
      caixa.appendChild(criar('div', 'etiqueta', 'FILA VAZIA'));
      return;
    }

    const idProximo = idDoProximo(fase);
    const todosJaJogaram = fase.fila.every(item => item.jogou);   // nova volta: ninguém aparece riscado
    

    fase.fila.forEach(item => {
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
    processarPedidoPendente: processarPedidoPendente
  };

})();
window.Fila = Fila;
