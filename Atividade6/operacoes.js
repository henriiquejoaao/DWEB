let num1 = parseFloat(prompt("Introduza o primeiro número:"));
let num2 = parseFloat(prompt("Introduza o segundo número:"));

let soma = num1 + num2;
let subtracao = num1 - num2;
let produto = num1 * num2;
let divisao = num1 / num2;
let resto = num1 % num2;

let resultados = "Resultados das operações:\n\n" +
                 "Soma: " + soma + "\n" +
                 "Subtração: " + subtracao + "\n" +
                 "Produto: " + produto + "\n" +
                 "Divisão: " + divisao + "\n" +
                 "Resto da divisão: " + resto;

if (confirm("Deseja apresentar os cálculos na tela?")) {
    alert(resultados);
}