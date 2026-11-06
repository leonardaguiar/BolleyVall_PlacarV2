// compartilhar.js - compartilha o SORTEIO (não o andamento) por link.
//
// Os dados do sorteio vão dentro do próprio link, depois do "#", compactados e em base64.
// O que fica depois do "#" não é enviado ao servidor: só viaja no link.
// Quem abre o link recebe as mesmas equipes e a mesma fila, e começa o acompanhamento do zero.
const Compartilhar = (function () {
  'use strict';

  const PREFIXO_HASH = '#sorteio=';
  const VERSAO_DO_FORMATO = 1;
  const ENDERECO_DO_ENCURTADOR = 'https://is.gd/create.php';
  const TEMPO_MAXIMO_DO_ENCURTADOR_MS = 5000;   // passou disso, usa o link completo
  const TAMANHO_MAXIMO_PARA_ENCURTAR = 5000;    // limite do is.gd para o link original

  // O link é gerado logo depois do sorteio. Assim o botão responde na hora,
  // o que é necessário para o menu de compartilhar do celular abrir.
  let linkPronto = null;
  let linkCurto = null;   // só existe depois que o is.gd responder; zera a cada sorteio

  // ---------- conversões de texto e bytes ----------
  function bytesParaBase64Url(bytes) {
    let texto = '';
    bytes.forEach(byte => { texto += String.fromCharCode(byte); });
    return btoa(texto).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlParaBytes(base64Url) {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const texto = atob(base64);
    const bytes = new Uint8Array(texto.length);
    for (let i = 0; i < texto.length; i++) bytes[i] = texto.charCodeAt(i);
    return bytes;
  }

  // ---------- compactação (deixa o link bem menor) ----------
  async function lerFluxoComoBytes(fluxo) {
    return new Uint8Array(await new Response(fluxo).arrayBuffer());
  }

  function comprimir(bytes) {
    const fluxo = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return lerFluxoComoBytes(fluxo);
  }

  function descomprimir(bytes) {
    const fluxo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return lerFluxoComoBytes(fluxo);
  }

  // O código começa com uma letra: "z" = compactado, "p" = texto puro (navegador sem compactação).
  async function codificar(dados) {
    const bytes = new TextEncoder().encode(JSON.stringify(dados));
    if (typeof CompressionStream === 'function') {
      return 'z' + bytesParaBase64Url(await comprimir(bytes));
    }
    return 'p' + bytesParaBase64Url(bytes);
  }

  async function decodificar(codigo) {
    const tipo = codigo.charAt(0);
    const bytes = base64UrlParaBytes(codigo.slice(1));
    if (tipo === 'z' && typeof DecompressionStream !== 'function') {
      throw new Error('Este navegador não consegue abrir o link compactado.');
    }
    const util = (tipo === 'z') ? await descomprimir(bytes) : bytes;
    return JSON.parse(new TextDecoder().decode(util));
  }

  // ---------- validação do que chega pelo link ----------
  function ehListaDeNomes(time) {
    return Array.isArray(time) && time.length > 0 && time.every(nome => typeof nome === 'string');
  }

  function ehFaseValida(fase) {
    return fase
      && (fase.modo === 'fila' || fase.modo === 'jogo')
      && typeof fase.titulo === 'string'
      && Array.isArray(fase.times)
      && fase.times.length >= 2
      && fase.times.every(ehListaDeNomes);
  }

  function ehLinhaValida(linha) {
    return Array.isArray(linha) && typeof linha[0] === 'string' && typeof linha[1] === 'string';
  }

  function dadosSaoValidos(dados) {
    return !!dados
      && dados.v === VERSAO_DO_FORMATO
      && !!dados.plano
      && typeof dados.plano.unit === 'string'
      && Array.isArray(dados.plano.fases)
      && dados.plano.fases.length > 0
      && dados.plano.fases.every(ehFaseValida)
      && Array.isArray(dados.linhas)
      && dados.linhas.every(ehLinhaValida);
  }

    // confere o que veio no link sobre o formulário; aceita só os campos e tipos esperados
  function limparFormulario(formulario) {
    if (!formulario || typeof formulario !== 'object') return null;
    const texto = valor => (typeof valor === 'string' ? valor.slice(0, 5000) : '');
    return {
      misto: formulario.misto === true,
      trio: formulario.trio === true,
      fixa: formulario.fixa === true,
      rodadas: texto(formulario.rodadas),
      maxHomens: texto(formulario.maxHomens),
      regraMax: formulario.regraMax === 'exato' ? 'exato' : 'ate',
      todos: texto(formulario.todos),
      homens: texto(formulario.homens),
      mulheres: texto(formulario.mulheres)
    };
  }

  const ehInteiroEntre = (valor, minimo, maximo) =>
  Number.isInteger(valor) && valor >= minimo && valor <= maximo;

  function ehFaseDoAndamentoValida(fase, quantidadeDeTimes) {
    const ehIdDeTime = id => ehInteiroEntre(id, 0, quantidadeDeTimes - 1);
    return !!fase
      && Array.isArray(fase.quadra) && fase.quadra.length === 2 && fase.quadra.every(ehIdDeTime)
      && Array.isArray(fase.fila)
      && fase.fila.every(item => !!item && ehIdDeTime(item.id) && typeof item.jogou === 'boolean')
      && !!fase.sequencia && typeof fase.sequencia === 'object'
      && Object.keys(fase.sequencia).every(chave => Number.isInteger(fase.sequencia[chave]))
      && fase.quadra.every(id => Number.isInteger(fase.sequencia[id]))
      && ehInteiroEntre(fase.jogos, 0, 100000)
      && (fase.vencedor === null || ehIdDeTime(fase.vencedor));
  }

  function ehJogoDoHistoricoValido(jogo) {
    return !!jogo
      && typeof jogo.titulo === 'string'
      && Number.isInteger(jogo.numero)
      && typeof jogo.vencedor === 'string'
      && typeof jogo.perdedor === 'string'
      && ehListaDeNomes(jogo.vencedores)
      && ehListaDeNomes(jogo.perdedores);
  }

  function andamentoEhValido(andamento, plano) {
    const estado = andamento && andamento.estado;
    return !!estado
      && Number.isFinite(andamento.geradoEm)
      && ehInteiroEntre(estado.faseAtual, 0, plano.fases.length - 1)
      && Array.isArray(estado.fases)
      && estado.fases.length === plano.fases.length
      && estado.fases.every((fase, indice) => ehFaseDoAndamentoValida(fase, plano.fases[indice].times.length))
      && Array.isArray(estado.historico)
      && estado.historico.every(ehJogoDoHistoricoValido);
  }

  // devolve só o que interessa; a pilha de desfazer começa vazia no aparelho que recebe
  function limparAndamento(andamento) {
    const estado = andamento.estado;
    return {
      geradoEm: andamento.geradoEm,
      estado: { faseAtual: estado.faseAtual, fases: estado.fases, historico: estado.historico, desfazer: [] }
    };
  }

  // Monta o link completo. Com "comAndamento", leva também o andamento atual do baba.
  async function gerarLink(comAndamento) {
    const sorteio = Fila.obterSorteio();     // { plano, linhas, formulario } ou null
    if (!sorteio) return null;

    const dados = {
      v: VERSAO_DO_FORMATO,
      plano: sorteio.plano,
      linhas: sorteio.linhas,
      formulario: sorteio.formulario
    };
    if (comAndamento) dados.andamento = Fila.obterAndamento();

    const codigo = await codificar(dados);
    return location.href.split('#')[0] + PREFIXO_HASH + codigo;
  }

  async function prepararLink() {
    linkCurto = null;
    linkPronto = null;
    try { linkPronto = await gerarLink(); } catch (erro) { linkPronto = null; }
  }

  // ---------- botão "Compartilhar sorteio" ----------
  async function copiarTexto(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch (erro) {
      const campo = document.createElement('textarea');
      campo.value = texto;
      document.body.appendChild(campo);
      campo.select();
      const copiou = document.execCommand('copy');
      campo.remove();
      return copiou;
    }
  }

  function mostrarAvisoNoBotao(botao, texto) {
    const original = botao.textContent;
    botao.textContent = texto;
    setTimeout(() => { botao.textContent = original; }, 1800);
  }

// o menu de compartilhar do sistema só é usado em celular/tablet; no PC o link é copiado
  function ehCelularOuTablet() {
    const agente = navigator.userAgent;
    const ehAndroidOuIphone = /android|iphone|ipad|ipod/i.test(agente);
    const ehIpadComoMac = /macintosh/i.test(agente) && navigator.maxTouchPoints > 1;
    return ehAndroidOuIphone || ehIpadComoMac;
  }

    // só vale encurtar endereços públicos (não arquivos do disco nem localhost)
  function ehEnderecoPublico() {
    const protocoloWeb = location.protocol === 'https:' || location.protocol === 'http:';
    const ehLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return protocoloWeb && !ehLocal;
  }

  function ehLinkCurtoValido(link) {
    return typeof link === 'string' && /^https:\/\/is\.gd\/[A-Za-z0-9_]+$/.test(link);
  }

  // Pede o link curto ao is.gd. Devolve null em qualquer problema (sem internet, erro, demora).
  async function encurtarLink(linkCompleto) {
    if (!navigator.onLine || !ehEnderecoPublico()) return null;
    if (linkCompleto.length > TAMANHO_MAXIMO_PARA_ENCURTAR) return null;

    const controle = new AbortController();
    const cronometro = setTimeout(() => controle.abort(), TEMPO_MAXIMO_DO_ENCURTADOR_MS);
    try {
      const endereco = ENDERECO_DO_ENCURTADOR + '?format=json&url=' + encodeURIComponent(linkCompleto);
      const resposta = await fetch(endereco, { signal: controle.signal, referrerPolicy: 'no-referrer' });
      if (!resposta.ok) return null;
      const dados = await resposta.json();
      return ehLinkCurtoValido(dados.shorturl) ? dados.shorturl : null;
    } catch (erro) {
      return null;
    } finally {
      clearTimeout(cronometro);
    }
  }

  // Devolve { link, curto }: o link curto se der, senão o link completo (que sempre funciona).
  async function obterLinkParaCompartilhar(botao) {
    if (linkCurto) return { link: linkCurto, curto: true };

    const textoOriginal = botao.textContent;
    botao.textContent = 'Gerando link...';
    botao.disabled = true;
    try {
      const linkCompleto = linkPronto || await gerarLink();
      if (!linkCompleto) return null;
      linkCurto = await encurtarLink(linkCompleto);
      return linkCurto ? { link: linkCurto, curto: true } : { link: linkCompleto, curto: false };
    } finally {
      botao.textContent = textoOriginal;
      botao.disabled = false;
    }
  }
  // Abre o menu de compartilhar (celular) ou copia o link (PC / sem menu).
  async function entregarLink(botao, link, curto, titulo) {
    if (navigator.share && ehCelularOuTablet()) {
      try {
        await navigator.share({ title: titulo, text: titulo + ' - BolleyVall Placar', url: link });
        return;
      } catch (erro) {
        if (erro.name === 'AbortError') return;   // a pessoa fechou o menu de compartilhar
        // outro erro: cai para copiar o link
      }
    }
    const copiou = await copiarTexto(link);
    const avisoCopiado = curto ? 'Link copiado!' : 'Link completo copiado!';
    mostrarAvisoNoBotao(botao, copiou ? avisoCopiado : 'Não foi possível copiar');
  }

  async function compartilhar(botao) {
    const resultado = await obterLinkParaCompartilhar(botao);
    if (!resultado) {
      alert('Faça o sorteio antes de compartilhar.');
      return;
    }
    await entregarLink(botao, resultado.link, resultado.curto, 'Sorteio de times');
  }

  // O andamento muda a cada jogo, então o link é gerado na hora (sem guardar o link curto).
  async function compartilharAndamento(botao) {
    const textoOriginal = botao.textContent;
    botao.textContent = 'Gerando link...';
    botao.disabled = true;

    let resultado = null;
    try {
      const linkCompleto = await gerarLink(true);
      if (linkCompleto) {
        const linkEncurtado = await encurtarLink(linkCompleto);
        resultado = linkEncurtado
          ? { link: linkEncurtado, curto: true }
          : { link: linkCompleto, curto: false };
      }
    } finally {
      botao.textContent = textoOriginal;
      botao.disabled = false;
    }

    if (!resultado) {
      alert('Não há andamento para compartilhar.');
      return;
    }
    await entregarLink(botao, resultado.link, resultado.curto, 'Andamento do baba');
  }

  // ---------- abrir um link recebido ----------
  // Devolve { plano, linhas }, ou null se a página não foi aberta por um link de sorteio.
  // Lança erro se o link existir mas estiver incompleto ou inválido.
  async function lerDoLink() {
    if (location.hash.indexOf(PREFIXO_HASH) !== 0) return null;
    const dados = await decodificar(location.hash.slice(PREFIXO_HASH.length));
    if (!dadosSaoValidos(dados)) throw new Error('Sorteio inválido');

    let andamento = null;
    if (dados.andamento) {
      if (!andamentoEhValido(dados.andamento, dados.plano)) throw new Error('Andamento inválido');
      andamento = limparAndamento(dados.andamento);
    }
    return {
      plano: dados.plano,
      linhas: dados.linhas,
      formulario: limparFormulario(dados.formulario),
      andamento: andamento
    };
  }

  // Tira o código do endereço, para recarregar a página não importar o sorteio de novo.
  function limparLinkDaBarra() {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  return {
    prepararLink: prepararLink,
    compartilhar: compartilhar,
    lerDoLink: lerDoLink,
    limparLinkDaBarra: limparLinkDaBarra,
    compartilharAndamento: compartilharAndamento
  };
})();
