let pesquisas = [];

function adicionarResposta() {
  let inputIdade = document.getElementById('idade');
  let selectSexo = document.getElementById('sexo');
  let selectOpiniao = document.getElementById('opiniao');

  let idade = parseInt(inputIdade.value);
  let sexo = selectSexo.value;
  let opiniao = parseInt(selectOpiniao.value);

  if (isNaN(idade) || idade <= 0) {
    alert("Por favor, insira uma idade válida.");
    return;
  }

  pesquisas.push({ idade, sexo, opiniao });

  inputIdade.value = '';
  inputIdade.focus();

  atualizarResultados();
}

function atualizarResultados() {
  let total = pesquisas.length;
  
  document.getElementById('contador').innerText = `Total de respostas: ${total} / 45`;

  if (total === 0) return;

  let somaIdade = 0;
  let maisVelha = pesquisas[0].idade;
  let maisNova = pesquisas[0].idade;
  let qtdPessimo = 0;
  let qtdOtimoBom = 0;
  let qtdMulheres = 0;
  let qtdHomens = 0;
  let qtdOutros = 0;

  for (let i = 0; i < total; i++) {
    let p = pesquisas[i];

    somaIdade += p.idade;

    if (p.idade > maisVelha) maisVelha = p.idade;
    if (p.idade < maisNova) maisNova = p.idade;

    if (p.opiniao === 1) qtdPessimo++;
    if (p.opiniao === 4 || p.opiniao === 3) qtdOtimoBom++;

    if (p.sexo === 'Feminino') qtdMulheres++;
    else if (p.sexo === 'Masculino') qtdHomens++;
    else if (p.sexo === 'Outros') qtdOutros++;
  }

  let mediaIdade = somaIdade / total;
  let pctOtimoBom = (qtdOtimoBom / total) * 100;

  document.getElementById('mediaIdade').innerText = mediaIdade.toFixed(1);
  document.getElementById('maisVelha').innerText = maisVelha;
  document.getElementById('maisNova').innerText = maisNova;
  document.getElementById('qtdPessimo').innerText = qtdPessimo;
  document.getElementById('pctOtimoBom').innerText = pctOtimoBom.toFixed(1);
  document.getElementById('qtdMulheres').innerText = qtdMulheres;
  document.getElementById('qtdHomens').innerText = qtdHomens;
  document.getElementById('qtdOutros').innerText = qtdOutros;
}