// The API and the solver answer in English, which is their contract. These are
// the sentences they can send, in Portuguese; anything unknown is shown as sent.
import { PLD_ERRORS, type PldErrorCode } from "../lib/pld";
import { getLocale } from "./index";

const PLD_PT: Record<PldErrorCode, string> = {
  encoding: "O arquivo não é texto UTF-8.",
  empty: "O arquivo está vazio.",
  header: "A linha de cabeçalho deve ser: hora,submercado,pld",
  no_rows: "O arquivo tem cabeçalho, mas nenhum preço.",
  fields: "Cada linha deve ser: hora,submercado,pld",
  timestamp: "hora deve ser um horário local no formato AAAA-MM-DDTHH:00.",
  offset: "hora deve ser o horário local do mercado, sem deslocamento UTC.",
  off_hour: "hora deve cair em hora cheia.",
  submarket: "submercado deve ser SE, S, NE ou N.",
  price: "pld deve ser um número decimal simples em BRL/MWh.",
  non_positive: "pld deve ser maior que zero.",
  duplicate: "Esta hora e submercado já aparecem antes no arquivo.",
  order: "As linhas devem estar em ordem cronológica.",
  gap: "As horas devem ser consecutivas, sem lacunas.",
  incomplete: "Cada hora deve ter os quatro submercados.",
  partial_day: "O arquivo deve ter dias inteiros, de 00:00 a 23:00.",
};

const EXACT_PT: Record<string, string> = {
  "The file is empty.": "O arquivo está vazio.",
  "The file is larger than 5 MB.": "O arquivo tem mais de 5 MB.",
  "Sign in to continue.": "Entre para continuar.",
  "Could not reach the server. Check your connection and try again.": "Não foi possível acessar o servidor. Verifique sua conexão e tente de novo.",
  "The upload could not reach storage. Try again.": "O envio não alcançou o armazenamento. Tente de novo.",
  "The server sent something that is not JSON.": "O servidor enviou algo que não é JSON.",
  "There is nothing here.": "Não há nada aqui.",
  "Something went wrong on our side; try again.": "Algo deu errado do nosso lado; tente de novo.",
  "size must be the file's length in bytes.": "size deve ser o tamanho do arquivo em bytes.",
  "Upload a price file: this deployment has no bundled prices.": "Envie um arquivo de preços: esta instalação não tem preços incluídos.",
  "prices_key must be the key POST /api/uploads returned.": "prices_key deve ser a chave retornada por POST /api/uploads.",
  "The run could not be queued.": "A simulação não pôde entrar na fila.",
  "The run could not be queued and has not counted against your quota; try again shortly.": "A simulação não pôde entrar na fila e não contou no seu limite; tente de novo em instantes.",
  "The uploaded price file was not found (uploads are kept 7 days); upload it again.": "O arquivo de preços enviado não foi encontrado (os envios são mantidos por 7 dias); envie-o de novo.",
  "The uploaded file does not match its sha256; upload it again.": "O arquivo enviado não corresponde ao seu sha256; envie-o de novo.",
  "There is no run with that id; runs are kept 7 days.": "Não há simulação com este id; as simulações são mantidas por 7 dias.",
  "Sign in again: your session is missing or has expired.": "Entre novamente: sua sessão não existe ou expirou.",
  "Too many requests from your address; wait a minute and try again.": "Muitas requisições do seu endereço; aguarde um minuto e tente de novo.",
  "The solver failed on this run. It has not counted against your daily runs; try again, perhaps over a shorter period.":
    "O solver falhou nesta simulação. Ela não contou no seu limite diário; tente de novo, talvez com um período menor.",
  "This run did not finish in the time available and has not counted against your daily runs. Try a shorter duration or fewer days.":
    "Esta simulação não terminou no tempo disponível e não contou no seu limite diário. Tente uma duração menor ou menos dias.",
  "This run was queued for an earlier version of the model and has not counted against your daily runs. Submit it again.":
    "Esta simulação entrou na fila para uma versão anterior do modelo e não contou no seu limite diário. Envie-a de novo.",
};

const decimal = (value: string) => value.replace(".", ",");

const PATTERNS_PT: [RegExp, (...groups: string[]) => string][] = [
  [/^The dates (\S+) to (\S+) are not all inside the prices, which run from (.+) to (.+)\.$/, (from, to, first, last) => `As datas de ${from} a ${to} não estão todas dentro dos preços, que vão de ${first} a ${last}.`],
  [/^A run covers at least (\d+) days, so that every calendar month is in it; extend the dates\.$/, (days) => `Uma simulação cobre no mínimo ${days} dias, para incluir todos os meses do calendário; amplie as datas.`],
  [/^A run covers at most (\d+) days after its start; shorten the dates\.$/, (days) => `Uma simulação cobre no máximo ${days} dias após o início; encurte as datas.`],
  [/^The bundled prices run from (\S+) to (\S+); pick dates inside them or upload a price file\.$/, (first, last) => `Os preços incluídos vão de ${first} a ${last}; escolha datas dentro desse período ou envie um arquivo de preços.`],
  [/^The server answered (\d+)\.$/, (status) => `O servidor respondeu ${status}.`],
  [/^Storage refused the upload \((\d+)\)\.$/, (status) => `O armazenamento recusou o envio (${status}).`],
  [/^delivers less than ([\d.]+) h at contracted power$/, (hours) => `entrega menos de ${decimal(hours)} h na potência contratada`],
  [/^discharge rate is below the contracted power$/, () => "tem taxa de descarga abaixo da potência contratada"],
  [/^cannot recharge the contracted ([\d.]+) h within ([\d.]+) h$/, (hours, limit) => `não recarrega as ${decimal(hours)} h contratadas em até ${decimal(limit)} h`],
  [/^round-trip efficiency is below (\d+)%$/, (rte) => `tem eficiência round-trip abaixo de ${rte}%`],
];

const pldCode = (text: string) => (Object.keys(PLD_ERRORS) as PldErrorCode[]).find((code) => PLD_ERRORS[code] === text);

/** A message from the API, the solver or the file check, in the active language. */
export function localizeServerMessage(message: string): string {
  if (getLocale() === "en") return message;
  const line = /^line (\d+): (.+)$/s.exec(message);
  if (line) {
    const code = pldCode(line[2]);
    return code ? `linha ${line[1]}: ${PLD_PT[code]}` : message;
  }
  if (EXACT_PT[message]) return EXACT_PT[message];
  for (const [pattern, render] of PATTERNS_PT) {
    const match = pattern.exec(message);
    if (match) return render(...match.slice(1));
  }
  return message;
}
