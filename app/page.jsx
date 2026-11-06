import Script from 'next/script';

export default function HomePage() {
  return (
    <>
      <div id="stage">
        <header>
          <div className="name-block a">
            <div className="team-name a" id="nameA" contentEditable={false} suppressContentEditableWarning>Time 1</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className="dots-btn" id="dotsA" type="button">⋮</button>
              <div className="swatches" id="swatchesA" />
            </div>
          </div>
          <div className="mid-col">
            <div className="timer" id="timer">00:00</div>
            <a className="draw-btn" href="/sortear.html">Sortear time</a>
          </div>
          <div className="name-block b">
            <div className="team-name b" id="nameB" contentEditable={false} suppressContentEditableWarning>Time 2</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="swatches" id="swatchesB" />
              <button className="dots-btn" id="dotsB" type="button">⋮</button>
            </div>
          </div>
        </header>

        <main>
          <div className="panel a" id="panelA">
            <div className="stepper">
              <button className="up" data-key="a" data-delta="1" type="button">▲</button>
              <button className="down" data-key="a" data-delta="-1" type="button">▼</button>
            </div>
            <div className="score" id="scoreA">0</div>
            <div className="hint">toque no campo para somar 1</div>
          </div>
          <div className="divider" />
          <button className="reset-btn" id="resetBtn" type="button">Encerrar partida</button>
          <button className="install-btn hidden" id="installBtn" title="Instalar app" aria-label="Instalar app" type="button">⬇</button>
          <span className="version-tag" id="versionTag">v1.0</span>
          <div className="panel b" id="panelB">
            <div className="stepper">
              <button className="up" data-key="b" data-delta="1" type="button">▲</button>
              <button className="down" data-key="b" data-delta="-1" type="button">▼</button>
            </div>
            <div className="score" id="scoreB">0</div>
            <div className="hint">toque no campo para somar 1</div>
          </div>
        </main>

        <div className="modal-overlay" id="modalOverlay">
          <div className="modal">
            <p id="resetMessage">Deseja encerrar a partida?</p>
            <div className="modal-actions">
              <button id="cancelReset" type="button">Cancelar</button>
              <button className="confirm" id="confirmReset" type="button">Encerrar</button>
            </div>
          </div>
        </div>
        <div className="modal-overlay" id="easterOverlay">
          <div className="modal">
            <div id="easterCredits">
              <p>Desenvolvido por<br /><strong>Leonardo Aguiar</strong><br />leo.aguiar.silva@gmail.com</p>
              <div className="modal-actions">
                <button id="easterClose" type="button">Fechar</button>
                <button className="confirm" id="easterPlay" style={{ background: '#2F6FED', borderColor: '#2F6FED' }} type="button">Jogar</button>
              </div>
            </div>
            <div id="easterGame" style={{ display: 'none' }}>
              <canvas id="ballCanvas" width="300" height="300" style={{ background: 'var(--bg)', borderRadius: 10, touchAction: 'none' }} />
              <p id="gameScore" style={{ margin: '10px 0 0', fontSize: 14 }}>Pontos: 0</p>
              <div className="modal-actions">
                <button id="easterGameClose" type="button">Fechar</button>
                <button className="confirm" id="gameReplay" style={{ display: 'none', background: '#2F6FED', borderColor: '#2F6FED' }} type="button">Jogar novamente</button>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-overlay" id="installOverlay">
          <div className="modal">
            <p id="installText">Instale este app na tela inicial para acesso rápido e em tela cheia.</p>
            <div className="modal-actions">
              <button id="installCancel" type="button">Fechar</button>
              <button className="confirm" id="installConfirm" style={{ background: '#2F6FED', borderColor: '#2F6FED' }} type="button">Instalar</button>
            </div>
          </div>
        </div>
      </div>
      <Script src="/fila.js" strategy="afterInteractive" />
      <Script src="/app.js" strategy="afterInteractive" />
    </>
  );
}