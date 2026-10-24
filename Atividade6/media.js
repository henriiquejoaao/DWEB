let nome = prompt("Introduza o nome do aluno:");
let nota1 = parseFloat(prompt("Introduza a 1ª nota:"));
let nota2 = parseFloat(prompt("Introduza a 2ª nota:"));
let nota3 = parseFloat(prompt("Introduza a 3ª nota:"));
let nota4 = parseFloat(prompt("Introduza a 4ª nota:"));

let media = (nota1 + nota2 + nota3 + nota4) / 4;

if (confirm("Deseja ver a média final calculada?")) {
    alert("Aluno(a): " + nome + "\nMédia: " + media.toFixed(2));
}