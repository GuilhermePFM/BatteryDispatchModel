# Mercado brasileiro: dados da CCEE e referências

*O que sabemos sobre o PLD, os dados em `data/raw/ccee`, o leilão de baterias e as
premissas do produto. Levantamento de 22/11/2026.*

[← README](../README.md) · [formulação atual](model/model.md) · [dados atuais](data.md)

Cada informação traz seu nível de confiança:

- **Medido**: calculado por nós a partir dos arquivos da CCEE.
- **Oficial**: lido em documento ou página de órgão do setor (ANEEL, MME, CCEE, EPE, BNDES).
- **Secundário**: vem de imprensa, consultoria ou escritório de advocacia. Confirmar
  no ato original antes de usar em um resultado para cliente.

---

## 1. Decisões de escopo

| Tema | Decisão |
| --- | --- |
| Pergunta do produto | Vale a pena comprar a bateria? |
| Localização | A bateria fica em **um único submercado** e carrega e descarrega nele |
| Escolha do submercado | É um resultado do produto |
| Casos de negócio do MVP | **Dois casos separados**, comparados por submercado: **Contratada (LRCAP)**, com receita fixa menos ressarcimentos e penalidades, e **Merchant**, com arbitragem no PLD e sem receita fixa |
| Camada financeira | VPL, TIR, payback, capex máximo viável, reposição, inflação e impostos, em R$ |
| Arbitragem durante o contrato de capacidade | **Não existe.** O despacho é do ONS e o resultado no PLD vai para a CONCAP (ver §6.3) |
| TUST/TUSD | Fora do escopo por enquanto |
| Horizonte de preços | Mantido o atual, sem cenários hidrológicos |
| Funil (acesso aberto, email para sensibilidades) | Mantido como está |

## 2. O PLD

O Preço de Liquidação das Diferenças é calculado pela CCEE **diariamente, para cada
hora do dia seguinte e para cada submercado**, a partir do Custo Marginal de Operação
(CMO) e respeitando os limites vigentes. *(Oficial: [CCEE, conceitos][ccee-conceitos])*

| Modelo | Horizonte | Discretização |
| --- | --- | --- |
| NEWAVE | até 5 anos | mensal |
| DECOMP | 2 meses | semanal no primeiro mês |
| DESSEM | até 7 dias | base do PLD horário oficial desde 01/01/2021 |

### Submercados

`SUDESTE`, `SUL`, `NORDESTE` e `NORTE`, como aparecem nos arquivos. *(Medido)*

### Limites

A REN ANEEL 1.032/2022 define piso e tetos para cada ano civil. O piso é o maior valor
entre a TEO Itaipu e a TEO das demais hidrelétricas. *(Oficial: [CCEE, conceitos][ccee-conceitos])*

| Limite 2026 | R$/MWh | Fonte |
| --- | --: | --- |
| Piso | 57,31 | Secundário ([Canal Solar][canal-pld]), confere com o mínimo dos dados |
| Teto estrutural | 785,27 | Secundário ([Canal Solar][canal-pld]) |
| Teto horário | 1.611,04 | Secundário ([Canal Solar][canal-pld]), confere com o máximo dos dados |

A CCEE cita o DSP ANEEL 3.850/2025 como ato de 2026, e seus valores devem ser conferidos
nele. O piso de 2025 nos dados é R$ 58,60/MWh. *(Medido)*

## 3. Os arquivos em `data/raw/ccee`

Exportados do [Painel de Preços][ccee-painel], que limita cada consulta a **seis meses**
e atualiza as séries no início de cada mês.

| Arquivo | Período real |
| --- | --- |
| `preco_horario-01.25-06.25.csv` | 20/01/2025 a 20/06/2025 |
| `preco_horario-6.25-12.25.csv` | 20/06/2025 a 20/12/2025 |
| `preco_horario-12.25-06.26.csv` | 20/12/2025 a 20/06/2026 |
| `preco_horario-5.26-11.26.csv` | 20/06/2026 a 20/11/2026 (o nome diz "5.26") |

**Formato:** CSV ASCII com `;` e decimal com vírgula. É uma tabela larga, com colunas
`Hora` (0 a 23), `Submercado` e uma coluna por dia em `d/m/aaaa`. Cada arquivo tem 96
linhas de dados (24 horas × 4 submercados).

**Qualidade** *(Medido)*:

- 16.080 horas de 20/01/2025 a 20/11/2026, sem hora faltante e sem valor nulo.
- Os arquivos se sobrepõem em um dia em cada fronteira (20/06/2025, 20/12/2025 e 20/06/2026;
  288 linhas), e os preços repetidos são idênticos.
- Os quatro submercados têm o mesmo preço (diferença até R$ 0,05) em 69,5% das horas.

| Ano | Horas | Mínimo | Máximo | Média SE | Média S | Média NE | Média N |
| --- | --: | --: | --: | --: | --: | --: | --: |
| 2025 (desde 20/01) | 8.304 | 58,60 | 1.421,87 | 233,41 | 236,07 | 183,67 | 189,65 |
| 2026 (até 20/11) | 7.776 | 57,31 | 1.611,04 | 194,37 | 214,81 | 175,96 | 176,79 |

## 4. Valor da arbitragem por submercado

**Método:** programa linear por submercado, com 1 MW, perdas de 5% na carga e na descarga,
degradação de 0,001% por ciclo e limite de 500 ciclos por ano. Usa **previsão perfeita**,
portanto é um **teto** da arbitragem. Não inclui custos de rede nem receita de capacidade.

### Últimos 12 meses (21/11/2025 a 20/11/2026) *(Medido)*

| Submercado | 2h (R$/MW-ano) | 4h (R$/MW-ano) | Capex máximo 2h (R$/kWh) | Capex máximo 4h (R$/kWh) |
| --- | --: | --: | --: | --: |
| Sudeste | 174.804 | 294.890 | 494 | 417 |
| Nordeste | 163.268 | 267.993 | 461 | 379 |
| Norte | 162.526 | 267.005 | 459 | 377 |
| Sul | 142.287 | 226.676 | 402 | 320 |

O capex máximo é o valor presente da receita em 10 anos a 12% ao ano, sem opex.

### Qual submercado escolher *(Medido)*

Comparação em 11 janelas móveis de 12 meses, com início mensal:

| Duração | Vitórias | Maior perda por fixar no Sudeste | Diferença entre melhor e pior |
| --- | --- | --: | --: |
| 2h | Sudeste 8, Nordeste 3 | R$ 1.889/MW-ano | 13% a 21% |
| 4h | Sudeste 11 | R$ 0 | 16% a 24% |

As janelas se sobrepõem e cobrem menos de dois anos, então isso **não prova** que o
Sudeste será sempre o melhor. O Sul, por exemplo, foi o segundo na primeira janela e
o último na mais recente.

### Outros sinais *(Medido)*

- Nos últimos 12 meses, 10% dos dias geraram de 37% a 42% da receita de arbitragem.
- Nos últimos 60 dias, cerca de 80% das horas ficaram no piso, e os picos sustentaram a receita.

## 5. Implicações para a formulação

Com um só submercado por bateria:

1. **Saem os dois mercados.** Somem `c1/c2`, `d1/d2` e o compromisso horário do Mercado 2
   (§4.5), e o período passa de 30 para 60 minutos.
2. **A escolha do local não precisa de variável binária.** Os submercados não se acoplam,
   então resolver os quatro separadamente e comparar é exato. Isso também entrega o
   ranking e a perda de escolher outro local, que um único vencedor não mostraria.
3. **O binário de carga/descarga deixa de ser necessário quando o preço é positivo.** Se
   houvesse carga `c` e descarga `d` na mesma hora, reduzir `c` em `δ` e `d` em
   `(1 - e_c)δ` mantém o estoque, reduz os ciclos e melhora o lucro em
   `p·δ·[1 - (1 - e_c)(1 - e_d)] > 0`. O piso do PLD é positivo, então o despacho vira um
   **programa linear**. Com perda zero há empate, e basta compensar carga e descarga.

**Verificação** *(Medido)*: um ano horário resolve em menos de 1 s como LP, sem nenhuma
hora com carga e descarga simultâneas, inclusive com orçamento de ciclos ativo. Em 14 dias,
LP e MILP deram o mesmo valor nos 4 submercados, mas nesses casos o orçamento não
chegou a limitar. **Decisão:** preços menores ou iguais a zero são rejeitados na entrada.

## 6. Leilão de capacidade (LRCAP Armazenamento 2026)

### 6.1 Regras conhecidas

| Item | Valor | Fonte |
| --- | --- | --- |
| Ato | Portaria Normativa MME nº 136, de 01/06/2026. A listagem da ANEEL traz 01/07/2026, mas o próprio ato e a referência de maio/2026 do CRCAP 7.2 confirmam junho | [DOU][dou-136], [índice dos documentos](leilao-lrcap-2026/README.md) |
| Leilões | Leilão 5/2026 (Armazenamento Nacional, produto A) em 02/12/2026; Leilão 6/2026 (Armazenamento, produto B) em 04/12/2026 | Editais 5/2026 e 6/2026, capa e cronograma |
| Prazo | 15 anos | Portaria 136, art. 9º, § 2º |
| Início do suprimento | 01/08/2028 | Portaria 136, art. 9º, § 3º |
| Contrato | CRCAP, com receita fixa paga pela disponibilidade, independente do despacho | CRCAP 1.1, 6.7 |
| Potência mínima | 30 MW | Portaria 136, art. 7º, III |
| Duração | 4 horas por ciclo completo, até 2 ciclos por dia e 366 a cada 12 meses | CRCAP 5.1.1(ii) |
| Despacho máximo | 12 horas de injeção por dia, somados os ciclos | CRCAP 5.1.1(iii) |
| Recarga completa | até 6 horas, incluído o repouso | CRCAP 5.1.1(vii) |
| Eficiência mínima | RTE de 85% no PMI, sem variação ao longo do contrato | Portaria 136, art. 7º, VI; CRCAP 8.1; Esclarecimentos L5, item 236 |
| Custo variável | Sem CVU positivo | Portaria 136, art. 7º, II |
| Operação | Despacho centralizado no ONS, vedado o despacho por conta própria | CRCAP 5.1.1(i) |
| Liquidação no PLD | Resultados positivos e negativos vão para a CONCAP | CRCAP 5.6; Edital, item 3.7.1 |
| Local | Sem limite por submercado; bônus locacional só para competição | [MME][mme] |
| Conteúdo nacional | Exigido no produto A, não no B | [Atlas Público][atlas], [BNDES][bndes] |
| Indexação | IPCA, reajuste anual em agosto, com base em maio/2026 | CRCAP 7.2, 7.3 |
| Preço inicial | **R$ 1.760.000/MW-ano** (produto A) e **R$ 1.580.000/MW-ano** (produto B) | Editais 5/2026 e 6/2026, item 10.5.1 |
| Valor-base por MW | **R$ 6.000.000/MW**, usado no teste de patrimônio líquido de consórcios (10% = R$ 600.000/MW). O plano o lê como investimento de referência, mas **os documentos não usam esse nome** | Edital, item 11.8.2.6.2; Esclarecimentos L5, item 20 |
| Garantias | Proposta de R$ 60.000/MW; fiel cumprimento de R$ 600.000/MW | Edital 5/2026, itens 8.2 e 13.1 |

Um projeto precisa de pelo menos **30 MW / 120 MWh**. O padrão atual do produto
(2 MW / 4 MWh) não se qualifica.

### 6.2 Receita, ressarcimentos e penalidades

Todos os itens abaixo são do CRCAP (Anexo I dos Editais 5/2026 e 6/2026).

| Item | Regra | Cláusula |
| --- | --- | --- |
| Receita fixa | Paga mensalmente sobre a potência contratada, independente do despacho | 6.2, 6.3, 6.7 |
| Ressarcimento de RTE | Energia de carga que excede a injetada ÷ 0,85, valorada ao custo médio de carga no PLD. Dispensado no mês com menos de 4 injeções | 8.1, 8.1.3 |
| Perdas até a subestação | Valoradas ao PLD, por conta do vendedor | 8.2 |
| Desvio de despacho | 1,15 × receita fixa unitária, na injeção e na recarga | 9.2, 9.3 |
| Disponibilidade declarada | 1,1 × receita fixa unitária sobre o que faltar | 9.4 |
| Atraso | 0,15 × receita fixa unitária por dia e MW em atraso | 6.8 |
| Indisponibilidade programada | Isenta até 2,5% ao ano | 5.7.1, 5.7.3 |
| Capacidade | Deve ser mantida por todo o contrato, sem revisão da receita por reinvestimento | 5.2.1, 7.7.1 |
| Resolução | Multa de 3 × a receita fixa anual | 13.1 |

**Ainda em aberto:** se os 366 ciclos usam janela móvel ou ano contratual. Os Esclarecimentos
remetem aos Procedimentos de Rede (Leilão 5, itens 154 e 466). O modelo adota a janela móvel,
que é a leitura conservadora.

### 6.3 Arbitragem e contrato não se somam

A premissa anterior, de que a bateria contratada poderia arbitrar o PLD, **estava errada**. O
despacho é centralizado no ONS (CRCAP 5.1.1(i)) e os resultados da liquidação no PLD vão para a
CONCAP (5.6). Os Esclarecimentos de 16/11/2026 confirmam que não há receita acessória (Leilão 5,
item 84; Leilão 6, item 25).

Por isso o produto compara **dois casos separados**. No caso contratado, a arbitragem no PLD é
apenas uma aproximação do despacho do ONS, usada para medir ciclos, desgaste e perdas. A
formulação está em [`model/model.md`](model/model.md).

## 7. Custos e regulação

**Capex** *(Secundário, sem base específica de grande porte)*:

- [NeoFeed][neofeed]: R$ 1.100 a 1.900/kWh.
- [ESS News][ess-capex]: R$ 3,97/Wh em 2020 e R$ 1,88/Wh em 2025, para um sistema de
  500 kW / 1.000 kWh.
- [Canal Solar][canal-nacional]: bateria nacional com selo Finame pode custar até 20% mais
  que a importada.

**Regulação** *(fora do escopo atual, registrada para o futuro)*:

- A [NT 03/2026][canal-cp] manteve a cobrança de uso da rede após a Lei 15.269/2025.
- Em maio de 2026, o relator propôs [não cobrar TUST/TUSD na carga][pv-tusd]. Não
  confirmamos o resultado final.
- O [Sebrae RN][sebrae] cita as RENs 1.161 e 1.162/2026 como marco do armazenamento, sem
  confirmação em outra fonte.
- Um [artigo da CIGRÉ][cigre] aponta a capacidade como a receita mais avançada na regulação
  e a arbitragem como de potencial limitado no Brasil.

## 8. Referências

**CCEE e órgãos do setor**

- [CCEE: conceitos de preços][ccee-conceitos]
- [CCEE: painel de preços][ccee-painel]
- [Portaria Normativa MME nº 136/2026 (DOU)][dou-136]
- [MME: diretrizes do leilão de baterias][mme]
- [EPE: LRCAP Armazenamento 2026][epe]
- [BNDES: LRCAP 2026][bndes]
- [ANEEL: consultas públicas][aneel-cp]

**Imprensa, consultorias e estudos**

- [Atlas Público: Portaria MME nº 136][atlas]
- [Canal Solar: limites do PLD 2026][canal-pld]
- [Canal Solar: consulta da ANEEL sobre armazenamento][canal-cp]
- [Canal Solar: BESS nacional][canal-nacional]
- [pv magazine Brasil: regulação do armazenamento][pv-tusd]
- [Simple Energy: consulta do leilão][simple]
- [Sebrae RN: novas regras][sebrae]
- [Modo Energy: Brazil battery storage outlook][modo]
- [CIGRÉ C5-11292: utility-scale batteries in Brazil][cigre]
- [NeoFeed][neofeed]
- [ESS News: custos e leilão no Brasil][ess-capex]

[ccee-conceitos]: https://www.ccee.org.br/precos/conceitos-precos
[ccee-painel]: https://www.ccee.org.br/precos/painel-precos
[dou-136]: https://www.in.gov.br/web/dou/-/portaria-normativa-mme-n-136-de-1-de-junho-de-2026-710152085
[mme]: https://www.gov.br/mme/pt-br/assuntos/noticias/mme-publica-diretrizes-para-leilao-inedito-de-armazenamento-de-energia-em-baterias-no-brasil
[epe]: https://www.epe.gov.br/pt/leiloes-de-energia/leiloes/leilao-de-reserva-de-capacidade-na-forma-de-potencia-armazenamento-2026
[bndes]: https://www.bndes.gov.br/wps/portal/site/home/financiamento/servicos-online/credenciamento-de-equipamentos/leilao-reserva-capacidade-forma-de-potencia-lrcap-2026
[aneel-cp]: https://antigo.aneel.gov.br/web/guest/consultas-publicas
[atlas]: https://atlaspublico.com.br/noticias/portaria-mme-n-136-define-regras-para-leiloes-de-baterias-52824
[canal-pld]: https://canalsolar.com.br/aneel-define-limite-pld-2026/
[canal-cp]: https://canalsolar.com.br/aneel-consulta-publica-armazenamento-de-energia/
[canal-nacional]: https://canalsolar.com.br/bess-nacional-vinte-porcento-mais-leilao-baterias/
[pv-tusd]: https://www.pv-magazine-brasil.com/2026/05/28/a-aneel-retomara-decisao-sobre-regulacao-do-armazenamento-na-proxima-semana/
[simple]: https://simpleenergy.com.br/aneel-abre-consulta-publica-sobre-leilao-de-baterias-rateio-dos-custos-sera-discutido-separadamente/
[sebrae]: https://energiaenegocios.rn.sebrae.com.br/armazenamento-de-energia-aneel/
[modo]: https://modoenergy.com/research/brazil-battery-storage-outlook-pde-2036
[cigre]: https://www.e-cigre.org/publications/detail/c5-11292-2026-utility-scale-battery-integration-in-brazil-feasibility-analysis-for-different-applications-and-regulatory-enablers.html
[neofeed]: https://neofeed.com.br/?p=223517
[ess-capex]: https://www.ess-news.com/2026/02/19/brazil-upcoming-auction-may-see-battery-storage-priced-significantly-cheaper-than-thermal-plants/
