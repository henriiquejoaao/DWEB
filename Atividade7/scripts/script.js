function iniciarJogo() {
  let seletor = document.getElementById('escolhaUsuario');
  let escolhaUsuario = seletor.value;

  let numeroAleatorio = Math.floor(Math.random() * 3);
  let escolhasPossiveis = ['Pedra', 'Papel', 'Tesoura'];
  let escolhaComputador = escolhasPossiveis[numeroAleatorio];

  let mensagem = `Você escolheu: <strong>${escolhaUsuario}</strong><br>`;
  mensagem += `Computador escolheu: <strong>${escolhaComputador}</strong><br><br>`;

  if (escolhaUsuario === escolhaComputador) {
    mensagem += "<strong>Empate! 🤝</strong>";
  } else if (
    (escolhaUsuario === 'Pedra' && escolhaComputador === 'Tesoura') ||
    (escolhaUsuario === 'Tesoura' && escolhaComputador === 'Papel') ||
    (escolhaUsuario === 'Papel' && escolhaComputador === 'Pedra')
  ) {
    mensagem += "<strong>Você venceu! 🎉</strong>";
  } else {
    mensagem += "<strong>O computador venceu! 🤖</strong>";
  }

  document.getElementById('resultado').innerHTML = mensagem;
}