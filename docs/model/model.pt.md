# Modelo de despacho e investimento da bateria

Tradução de [`model.md`](model.md), que é a referência. Formulação da pergunta de
investimento do BatteryPlan para o mercado de PLD horário do Brasil: vale a pena
comprar esta bateria, em qual submercado e sob qual modelo de negócio?

> **Situação: implementado.** `src/battery_plan/modelling/` resolve as §2 a §6, e
> `web/src/finance/` calcula a §8 no navegador.

---

## 1. Definição do problema

Uma bateria fica em **um** dos quatro submercados do Brasil (SE, S, NE ou N), e
essa escolha é um resultado do produto. Dois casos de negócio separados são
avaliados para cada submercado:

- **Contratado (LRCAP).** O proprietário vende capacidade no leilão de reserva de
  armazenamento de 2026 e recebe uma receita fixa, menos ressarcimentos e
  penalidades. O ONS despacha o ativo centralizadamente e o resultado da
  liquidação da sua energia no PLD vai para a conta CONCAP (CRCAP 5.1.1(i), 5.6),
  então o proprietário não ganha com arbitragem. A arbitragem contra o PLD serve
  aqui apenas como **proxy do despacho do ONS**, para medir ciclos, desgaste e
  perdas.
- **Merchant.** O proprietário negocia no PLD e não tem receita fixa. Os limites
  do contrato não se aplicam.

Os dois casos não podem ser somados. Os esclarecimentos publicados em 16/11/2026
afirmam que o contrato não deixa receita acessória a compartilhar (Leilão 5 item
84, Leilão 6 item 25).

A bateria é **tomadora de preço**: suas ações não movem o PLD, então a série de
preços é uma entrada exógena. Os preços também são tomados como **conhecidos**: o
horizonte inteiro é dado antes de qualquer decisão.

O problema tem duas camadas. A **camada de despacho** (§2 a §6) é um programa em
eixo horário, resolvido uma vez por submercado e caso: oito soluções. A **camada
de investimento** (§8) transforma cada solução em fluxos de caixa e roda no
navegador, sem nova resolução. Os fatos de mercado e suas fontes estão em
[`mercado-brasileiro.md`](../mercado-brasileiro.md), e os documentos oficiais do
leilão estão indexados em
[`leilao-lrcap-2026/README.md`](../leilao-lrcap-2026/README.md).

## 2. Notação

### Conjuntos e índices

| Símbolo | Significado |
| --- | --- |
| $t \in \mathcal{T}$ | período horário de liquidação, $t = 1, \dots, T$ |
| $\delta \in \mathcal{D}$ | dia do calendário, em horário local |
| $\mathcal{T}_\delta$ | as 24 horas do dia $\delta$, terminando na hora $e(\delta)$ |
| $s \in \mathcal{S}$ | submercado: SE, S, NE, N |
| $b \in \{\text{C}, \text{M}\}$ | caso de negócio: contratado ou merchant |

### Parâmetros

| Símbolo | Padrão | Unidade | Significado |
| --- | --- | --- | --- |
| $\Delta t$ | 1 | h | duração de um período de liquidação |
| $p_{s,t}$ | dados | – | PLD horário do submercado $s$ em BRL/MWh, acima de zero |
| $P$ | entrada | MW | potência entregue à rede, a disponibilidade contratada no caso C |
| $E$ | $4P/\eta_d$ | MWh | volume nominal de armazenamento, antes da degradação |
| $\overline{C}$ | $P$ | MW | taxa máxima de carga, no lado da rede |
| $\overline{D}$ | $P / \eta_d$ | MW | taxa máxima de descarga, no lado do armazenamento |
| $\eta_c,\ \eta_d$ | $\sqrt{0.85}$ | – | eficiências de carga e de descarga, em cada sentido |
| $\rho$ | $10^{-5}$ | /cycle | volume de armazenamento perdido por ciclo completo equivalente |
| $\overline{L}$ | nenhum | cycles | limite opcional de vida em ciclos no horizonte |
| $\kappa$ | $\eta_d E / (4P)$ | – | ciclos completos contratuais por ciclo completo físico |

Os valores padrão dimensionam uma bateria para o contrato: quatro horas entregues
e eficiência round-trip de 85%. Carga e descarga são simétricas em $P$ no lado da
rede, então uma recarga completa leva $4 / 0.85 \approx 4.7$ h, dentro das seis
horas permitidas pelo contrato. Com esses valores, $\kappa = 1$. Uma bateria
superdimensionada tem $\kappa > 1$, porque um ciclo físico entrega então mais de
um ciclo contratual.

### Variáveis de decisão

| Símbolo | Domínio | Unidade | Significado |
| --- | --- | --- | --- |
| $c_t$ | $\geq 0$ | MW | potência de carga importada da rede |
| $d_t$ | $\geq 0$ | MW | potência de descarga retirada do armazenamento |
| $S_t$ | $\geq 0$ | MWh | energia armazenada ao fim da hora $t$ |
| $n_t$ | $\geq 0$ | cycles | ciclos completos equivalentes físicos acumulados até $t$ |
| $z_t$ | binária, só no caso C | – | 1 quando a hora $t$ conta como hora de injeção |

Os dois lados são medidos em pontos diferentes. $c_t$ é a potência **importada da
rede**, da qual $\eta_c c_t$ chega ao armazenamento. $d_t$ é a potência **retirada
do armazenamento**, da qual $\eta_d d_t$ chega à rede. O armazenamento é debitado
do $d_t$ inteiro na §4.2, e apenas $\eta_d d_t$ é remunerado na §3.

## 3. Objetivo

Para o submercado $s$ e o caso $b$, maximizar o valor da energia negociada no
horizonte:

$$
\max \; V_{s,b} = \sum_{t \in \mathcal{T}} p_{s,t} \,\bigl(\eta_d\, d_t - c_t\bigr)\, \Delta t
$$

No caso M esta é a receita merchant, antes do fator de captura da §8. No caso C
ela **não é receita**: a CRCAP 5.6 envia o resultado da liquidação à CONCAP. Ela é
o critério que faz o despacho proxy carregar quando a energia está barata e
injetar quando está escassa.

## 4. Restrições

As §4.1 a §4.4, §4.6 e §4.7 se aplicam aos dois casos. A §4.5 se aplica apenas ao
caso C.

### 4.1 Limites de armazenamento

A energia armazenada fica entre vazio e o volume efetivo de armazenamento, que
encolhe conforme a bateria degrada (§4.7).

$$
0 \leq S_t \leq E\,\bigl(1 - \rho\, n_t\bigr) \qquad \forall t \in \mathcal{T}
$$

### 4.2 Balanço de energia

A energia armazenada passa de uma hora para a seguinte. A carga tem perdas, então
apenas $\eta_c c_t$ é armazenado. A descarga debita o armazenamento do $d_t$
inteiro, e a perda de descarga é considerada na §3.

$$
S_t = S_{t-1} + \Delta t \,\bigl( \eta_c\, c_t - d_t \bigr) \qquad \forall t \in \mathcal{T}, \qquad S_0 = 0
$$

A eficiência round-trip é $\eta_c \eta_d$. No mínimo contratual de 0,85, é preciso
um spread de preço de cerca de 18% para um ciclo empatar.

### 4.3 Limites de taxa

$$
0 \leq c_t \leq \overline{C}, \qquad 0 \leq d_t \leq \overline{D} \qquad \forall t \in \mathcal{T}
$$

Nenhuma binária separa carga e descarga: a §5.1 prova que um plano ótimo nunca faz
as duas na mesma hora.

### 4.4 Restrições de capacidade

A carga é limitada pela folga do armazenamento, e a descarga pelo que ele contém.

$$
\begin{aligned}
\Delta t\, \eta_c\, c_t &\leq E\,(1 - \rho\, n_t) - S_{t-1} \\
\Delta t\, d_t &\leq S_{t-1}
\end{aligned}
$$

Ambas decorrem das §4.1 e §4.2 em qualquer hora que não carregue e descarregue ao
mesmo tempo, o que a §5.1 mostra que um plano ótimo nunca faz. Elas explicitam o
que os limites impõem indiretamente, e a implementação pode omiti-las.

### 4.5 Obrigações do contrato de capacidade

Esta seção se aplica **apenas ao caso C**. O caso merchant não herda nenhum destes
limites. Os números de cláusula se referem à minuta do CRCAP, Anexo I dos Editais
5/2026 e 6/2026-ANEEL.

| Obrigação | Cláusula | Tratamento |
| --- | --- | --- |
| 4 h entregues por ciclo completo | 5.1.1(ii), Portaria 136 art. 7 IV | Dimensionamento: $E\,\eta_d \geq 4P$ e $\overline{D}\,\eta_d \geq P$ |
| Recarga do armazenamento contratado em até 6 h | 5.1.1(vii), Apêndice III | Dimensionamento: $\overline{C}\,\eta_c \geq 4P / (6\,\eta_d)$ |
| Eficiência round-trip de 85% | 8.1, Portaria 136 art. 7 VI | Dimensionamento, e qualquer déficit alimenta o ressarcimento da §8 |
| Mínimo de 30 MW | Portaria 136 art. 7 III | Apenas aviso: o projeto não se qualifica para o leilão |
| No máximo 2 ciclos completos por dia | 5.1.1(ii) | Linha por dia |
| No máximo 366 ciclos completos a cada 12 meses | 5.1.1(ii), 5.1.2 | Linha móvel por hora |
| No máximo 12 h de injeção por dia | 5.1.1(iii) | Binária $z_t$ |
| Capacidade mantida por 15 anos | 5.2.1, 7.7.1 | Camada de investimento (§8) |

**Ciclo completo.** O contrato conta ciclos pela **energia descarregada**: a soma
das descargas parciais que juntas igualam a potência contratada vezes quatro
horas, líquida de perdas (Apêndice III, CICLO COMPLETO). A energia entregue na
hora $t$ é $\eta_d d_t \Delta t$, então a contagem contratual é a contagem física
da §4.6 escalada por $\kappa$:

$$
\frac{\eta_d \sum_{\tau \leq t} d_\tau \Delta t}{4P} = \kappa\, n_t
$$

**Limites diário e anual de ciclos.** Ambos são lineares em $n_t$:

$$
\begin{aligned}
\kappa\,\bigl(n_{e(\delta)} - n_{e(\delta - 1)}\bigr) &\leq 2 && \forall \delta \in \mathcal{D} \\
\kappa\,\bigl(n_t - n_{t - 8760}\bigr) &\leq 366 && \forall t \geq 8760, \quad n_0 = 0
\end{aligned}
$$

A janela é lida como **móvel**, a leitura conservadora. A cláusula diz "a cada 12
(doze) meses" e a Portaria diz "anuais" (art. 4, §3). Os proponentes perguntaram
qual se aplica, e a resposta publicada remete aos Procedimentos de Rede sem
resolver a questão (esclarecimentos do Leilão 5, itens 154 e 466). Como $n_t$ é
não decrescente, a linha em $t = 8760$ também cobre todas as horas anteriores.

**Doze horas de injeção por dia.** A CRCAP 5.1.1(iii) permite ao ONS despachar por
mais de quatro horas em potência reduzida, até "12 (doze) horas de despacho ao
longo do dia", somando todos os ciclos do dia. A contagem é de horas de
**injeção** e a recarga é limitada separadamente. Uma binária por hora expressa
isso exatamente:

$$
\begin{aligned}
d_t &\leq \overline{D}\, z_t, \quad z_t \in \{0, 1\} && \forall t \in \mathcal{T} \\
\sum_{t \in \mathcal{T}_\delta} z_t &\leq 12 && \forall \delta \in \mathcal{D}
\end{aligned}
$$

Qualquer injeção positiva em uma hora consome a hora inteira, a leitura
conservadora em resolução horária. Esta linha torna o caso C um programa inteiro
misto, e a §6 mostra quando as binárias podem ser dispensadas.

### 4.6 Vida em ciclos

Um ciclo completo equivalente físico é a movimentação de um volume nominal de
armazenamento. Um ciclo só se completa quando a energia é descarregada, então a
contagem é feita apenas na descarga, no lado do armazenamento:

$$
n_t = n_{t-1} + \frac{\Delta t\, d_t}{E} \quad \forall t \in \mathcal{T}, \qquad n_0 = 0
$$

e, quando há limite, $n_T \leq \overline{L}$.

$n_t$ é mantido contínuo. O denominador é o $E$ nominal e não o volume degradado,
o que mantém a restrição linear.

### 4.7 Degradação do volume de armazenamento

Cada ciclo completo equivalente custa uma fração fixa $\rho$ do volume de
armazenamento:

$$
S^{\max}_t = E\,\bigl(1 - \rho\, n_t\bigr) \qquad \forall t \in \mathcal{T}
$$

Isso é linear em $n_t$ e é substituído na §4.1 em vez de virar uma variável. A
degradação por calendário não depende do despacho, então é aplicada na camada de
investimento (§8).

## 5. Premissas e simplificações

- **Tomadora de preço.** Os preços são exógenos, nos dois casos.
- **Os preços são conhecidos em todo o horizonte.** O plano é escolhido com
  previsão perfeita, então o valor merchant é um **teto** do que um operador
  poderia ganhar, e não uma previsão de receita. A §8 aplica um fator de captura
  sobre ele.
- **Os preços são estritamente positivos.** O PLD tem piso positivo, e o
  carregador rejeita qualquer preço igual ou abaixo de zero, inclusive em
  arquivos enviados. A §5.1 depende disso.
- **O proxy não é uma previsão do despacho do ONS.** No caso C ele estima ciclos,
  desgaste e perdas. Se o ONS despacharia o ativo dessa forma está fora do modelo.
- **A bateria começa vazia.** $S_0 = 0$, e o estado final é livre.
- **Um ponto de conexão.** As perdas entre o PMI e o barramento da subestação
  (CRCAP 8.2) não são separadas de $\eta_c$ e $\eta_d$. O consumo auxiliar conta
  como energia de carga para a RTE (esclarecimentos do Leilão 5, item 236), então
  as eficiências informadas devem incluí-lo.
- **Fora do escopo.** TUST/TUSD, cenários hidrológicos e qualquer receita além
  das previstas na §8.

### 5.1 Por que não é preciso uma binária de carga/descarga

**Afirmação.** Se $p_t > 0$ e $\eta_c \eta_d < 1$, nenhum plano ótimo carrega e
descarrega na mesma hora.

**Prova.** Tome um plano viável com $c_t > 0$ e $d_t > 0$. Seja
$\epsilon = \min(c_t,\ d_t / \eta_c) > 0$ e substitua

$$
c_t' = c_t - \epsilon, \qquad d_t' = d_t - \eta_c\, \epsilon
$$

O novo plano é viável:

- $\eta_c c_t - d_t$ não muda, então $S_\tau$ é o mesmo em todas as horas.
- As taxas caem e continuam não negativas, pela escolha de $\epsilon$.
- $n_\tau$ cai ou se mantém para todo $\tau \geq t$, então o limite da §4.1 fica
  mais folgado. O mesmo vale para as linhas de ciclos das §4.5 e §4.6, já que as
  diferenças $n_{e(\delta)} - n_{e(\delta-1)}$ e $n_\tau - n_{\tau - 8760}$ só
  podem cair quando o único incremento em $t$ cai.
- $z_t$ não muda, e $d_t' \leq d_t \leq \overline{D} z_t$.

O objetivo muda em

$$
p_t \bigl(\eta_d (d_t' - d_t) - (c_t' - c_t)\bigr) \Delta t = p_t\, \epsilon\, \bigl(1 - \eta_c \eta_d\bigr) \Delta t > 0
$$

então o plano original não era ótimo. $\blacksquare$

**Perda zero.** Com $\eta_c \eta_d = 1$ a mudança é zero e existem empates. A mesma
substituição, aplicada como etapa de compensação após a resolução, devolve um
plano de igual valor sem fluxos simultâneos.

**Preços não positivos** quebrariam a afirmação, pois receber para importar
poderia tornar lucrativo circular energia. Eles são rejeitados na entrada.

## 6. Abordagem de solução

### Solver

HiGHS, por meio do `pulp`. Cada submercado e caso é um programa sobre todo o
horizonte.

### Um programa por horizonte

O caso merchant é um **programa linear**. O caso de teste (1 MW entregue, 4 h, RTE
85%, 0,001%/ciclo, 670 dias) resolve em cerca de 2,3 s e 245 MB pelo PuLP, contra
o limite de 600 s da Lambda do solver, com as configurações padrão do HiGHS.
Uma janela móvel de 24+24 h ficou a 0,03–0,12% desse valor, então não economiza
nada que justifique a complexidade.

### O caso contratado: relaxação primeiro

O caso C carrega as binárias da §4.5, mas elas raramente importam. O solver
primeiro resolve o caso C **sem** $z_t$. Esse programa é uma relaxação do MILP,
então seu valor é um limite superior.

**Se nenhum dia da solução relaxada tiver mais de 12 horas de injeção, essa
solução é ótima para o MILP.** Definir $z_t = 1$ exatamente onde $d_t > 0$ a torna
viável, e um ponto viável que atinge um limite superior é ótimo. O branch and
bound é então dispensado.

Caso contrário, o MILP é resolvido. Dois ciclos completos em potência plena levam
$2E/\overline{D}$ horas, então espera-se que o limite atue principalmente em
baterias de mais de 6 h. Nos dados da CCEE ele não atuou em nenhuma de 28
configurações de 4 a 24 h, e com as binárias forçadas em todos os dias a resolução
mais lenta levou 57,8 s ([`solve.md`](../solve.md#the-12-h-limit)).

### Escolha do submercado

A bateria está em um submercado e os submercados não se acoplam, então resolver
cada um de forma independente e comparar é **exato**. Nenhuma binária de
localização é necessária. Com $V^\star_b = \max_{s} V_{s,b}$, o **arrependimento**
de construir em $s$ é

$$
\text{regret}_{s,b} = V^\star_b - V_{s,b} \geq 0
$$

O produto resolve **oito programas**, quatro submercados por dois casos.

**O ranking vem do caso merchant.** A receita fixa é a mesma em todos os
submercados, então as diferenças no caso C são artefatos do proxy. Para o caso C,
o produto informa "sem diferença locacional relevante".

### Quanta previsão é suficiente

Um único programa enxerga o horizonte inteiro, inclusive os dias que um operador
ainda não conheceria. Mesmo uma janela móvel de 24+24 h enxerga amanhã ao decidir
hoje. Um **backtest 24+0** decide então cada dia sem ver o seguinte. A razão entre
essa receita e o valor com previsão perfeita define o **fator de captura** $\phi$
da §8, mostrado com sua sensibilidade. Em 4 h ele vai de 0,965 a 0,980, conforme o
submercado ([`solve.md`](../solve.md#capture-factor-240-backtest)). Ele ainda é um
limite superior, pois o backtest vê por inteiro os preços de cada dia.

## 7. Resultados

Nos dados da CCEE, uma bateria que entrega 1 MW por 4 h com os valores padrão da
§2 obtém um valor merchant de ano balanceado de BRL 244.503 por MW-ano no SE, e
BRL 298.920 nos últimos doze meses, uma diferença que mostra o quanto a escolha do
período move a resposta. Ambos são tetos com previsão perfeita. Os quatro
submercados e os tempos de resolução estão em
[`solve.md`](../solve.md#the-eight-programs).

## 8. Camada de investimento

> Implementada em `web/src/finance/` e verificada contra a referência independente
> `scripts/finance_golden_vectors.py`. Todos os dados aqui rodam no navegador, não
> exigem resolução e ficam **fora do hash de parâmetros**.

### 8.1 Dados de entrada

Os dados com fonte contratual são fixados por ela. Todos os demais valores padrão
são **premissas editáveis** sem fonte de mercado, e a interface deve identificá-los
como tal.

| Símbolo | Significado | Fonte |
| --- | --- | --- |
| $RF_0$ | receita fixa na base de maio de 2026 (BRL/MW-ano) | o lance; tetos de BRL 1.760.000 (produto A) e BRL 1.580.000 (produto B), Editais 5/2026 e 6/2026, item 10.5.1 |
| $\pi$ | IPCA (%/ano) | premissa editável |
| $r$ | taxa de desconto nominal (taxa mínima de atratividade ou WACC) (%/ano) | dado do cliente; DI e NTN-B apenas como referência |
| $g$ | crescimento real do PLD (%/ano) | premissa editável, padrão 0% |
| $\phi$ | fator de captura do teto merchant | medido pelo backtest 24+0, por submercado e duração; editável |
| $K$ | capex, em BRL do mês em que o modelo rodou | premissa editável |
| $O_0$ | opex fixo na base de maio de 2026 (BRL/ano) | premissa editável |
| $\theta_R,\ \theta_I$ | alíquotas sobre a receita e sobre o lucro | premissas editáveis |
| $N_D$ | vida da depreciação fiscal linear (anos) | premissa editável |
| $\gamma$ | degradação por calendário (%/ano) | premissa editável |
| $x_R$ | custo de renovar o volume inteiro, como parcela do capex pago, $K_0$ | premissa editável |
| $\Pi_k$ | provisão para penalidades no ano contratual $k$ (BRL) | premissa editável, padrão 0 |

O item 11.8.2.6.2 do Edital usa BRL 6.000.000 por MW como base do teste de
patrimônio líquido do consórcio (10% disso, BRL 600.000 por MW, conforme os
esclarecimentos do Leilão 5, item 20). Os documentos não o chamam de referência de
investimento. Ele pode ser oferecido como **ponto de partida para $K$**,
identificado como premissa.

### 8.2 Linha do tempo e indexação

Os anos contratuais $k = 1, \dots, 15$ vão de agosto a julho. O suprimento começa
em 1º de agosto de 2028 para os dois produtos, com prazo de 15 anos (Portaria 136,
art. 9, parágrafos 2 e 3). A receita fixa é referenciada a **maio de 2026** e
reajustada a cada agosto pelo IPCA do julho anterior (CRCAP 7.2, 7.3). O ano $k$
fica portanto

$$
a_k = \frac{26}{12} + (k - 1)
$$

anos após a data-base, sendo 26 meses de maio de 2026 a julho de 2028. A receita
fixa, o opex e o PLD usam esse mesmo expoente, de modo que os produtos A e B e os
dois casos de negócio compartilham uma data-base. O capex $K$ é precificado no mês
em que o modelo rodou. Com $b$ os anos desse mês até agosto de 2028 (zero se já
passou), o pagamento nominal em $k = 0$ é $K_0 = K(1 + \pi)^b$, e a §8.4 indexa o
reinvestimento a partir dessa data. Os fluxos de caixa são nominais, ao fim do ano,
e descontados até $k = 0$ pela taxa nominal $r$. A taxa real equivalente, mostrada
como referência e não usada para descontar, é

$$
r_{\text{real}} = \frac{1 + r}{1 + \pi} - 1
$$

### 8.3 Receita-base a partir do despacho

O solver enxerga 670 dias. 305 dias do calendário ocorrem em 2025 e em 2026, e 60
em apenas um deles, então uma soma simples daria peso excessivo a parte do ano. A
base anual dá **o mesmo peso a cada mês do calendário**. Com $v_\delta$ o valor do
dia $\delta$ atualizado para a base de maio de 2026 pelo índice IPCA $I$,
$\mathcal{D}_m$ os dias observados no mês $m$ do calendário, e $D_m$ seus dias em
um ano de 365 dias,

$$
R_{\text{base}} = \sum_{m=1}^{12} \frac{D_m}{\lvert \mathcal{D}_m \rvert} \sum_{\delta \in \mathcal{D}_m} v_\delta,
\qquad
v_\delta = \frac{I_{\text{May 2026}}}{I_{m(\delta)}} \sum_{t \in \mathcal{T}_\delta} p_{s,t}\,(\eta_d d_t - c_t)\,\Delta t
$$

O despacho em si é resolvido sobre o PLD nominal. Atualizar os valores diários
depois é uma aproximação que mantém os dados macro fora do solver. Os últimos doze
meses aparecem como sensibilidade.

### 8.4 Capacidade, degradação e reposição

Com $\nu$ ciclos físicos por ano, a fração utilizável do volume nominal cai a cada
ano por

$$
y = (1 - \gamma)(1 - \rho\,\nu), \qquad h_1 = 1
$$

Se $s_k$ é a parcela de $E$ comprada no ano $k$, seu custo é

$$
\text{Repl}_k = x_R\, s_k\, K_0\, (1 + \pi)^{k - 1}
$$

$K_0$ é o preço em $k = 0$, então o índice corre a partir daí: $a_k - a_1 = k - 1$.

No **caso C** a capacidade contratada deve ser mantida o tempo todo (CRCAP 5.2.1).
O contrato prevê reinvestimento para trocar ou **adicionar** módulos de
armazenamento, e não revisa a receita fixa por isso (7.7.1). O caso, portanto,
adiciona apenas o que a degradação removeu. Com $\underline{h} = 4P / (E\,\eta_d)$
a parcela de $E$ que entrega as 4 h contratadas,

$$
s_k = \max\bigl(0,\ \underline{h} - y\, h_{k-1}\bigr), \qquad h_k = y\, h_{k-1} + s_k \qquad (k \geq 2)
$$

Assume-se que os módulos adicionados degradam junto com o restante do
armazenamento e que seu custo escala com a energia adicionada. Ambas são
simplificações: não há custo fixo de mobilização, e $x_R$ é uma premissa editável.

No **caso M** o cronograma é uma entrada. Uma reposição renova o volume inteiro,
então $s_k = 1$ e $h_k = 1$ em um ano programado e $h_k = y\,h_{k-1}$ nos demais,
e a receita escala com $h_k$.

### 8.5 Fluxos de caixa

**Contratado.** Receita fixa, indexada ao IPCA, menos o que o contrato cobra:

$$
\begin{aligned}
\text{Rev}^{\text{C}}_k ={}& RF_0\, P\, (1 + \pi)^{a_k} \\
&- \text{Ress}_{\text{base}}\, \bigl[(1 + g)(1 + \pi)\bigr]^{a_k} - \Pi_k
\end{aligned}
$$

A liquidação do despacho no PLD não aparece, pois pertence à CONCAP (CRCAP 5.6).
$\text{Ress}_{\text{base}}$ é a soma do ano balanceado, como na §8.3, do
ressarcimento mensal da CRCAP 8.1:

$$
\text{Ress}_m = \max\!\left(0,\ E^{\text{rec}}_m - \frac{S_{\text{end}(m)} + E^{\text{inj}}_m - S_{\text{end}(m-1)}}{0.85}\right) \frac{\text{Cost}_m}{E^{\text{rec}}_m}
$$

em que $E^{\text{rec}}_m = \sum c_t \Delta t$ é a energia de carga,
$E^{\text{inj}}_m = \sum \eta_d d_t \Delta t$ a energia injetada e
$\text{Cost}_m = \sum p_t c_t \Delta t$ o custo de carga, nas horas do mês $m$. O
termo é zero em um mês sem carga e em um mês com menos de quatro injeções (8.1.3).

Uma eficiência de 85% **não** faz este termo desaparecer em todos os meses. O
estoque é medido dentro do armazenamento e a injeção depois da perda de descarga,
então a energia trazida do mês anterior reduz a franquia do mês em sua perda de
descarga. Um mês que termina com menos energia armazenada do que começou pode,
assim, dever um pequeno valor, que o piso em zero impede os meses seguintes de
devolver.

**Merchant.** O valor com previsão perfeita, escalado pelo fator de captura, pelo
crescimento real do PLD, pelo IPCA e pela capacidade restante:

$$
\text{Rev}^{\text{M}}_k = \phi\, R_{\text{base}}\, h_k\, \bigl[(1 + g)(1 + \pi)\bigr]^{a_k}
$$

**Comum aos dois.** O opex é $O_k = O_0 (1 + \pi)^{a_k}$. A depreciação
$\text{Dep}_k$ é linear em $N_D$ anos sobre os valores efetivamente pagos por $K_0$
e por cada reposição, **sem correção por $\pi$**. Com lucro tributável
$B_k = (1 - \theta_R)\,\text{Rev}_k - O_k - \text{Dep}_k$ e um saldo de prejuízos
$\ell_k$ levado adiante,

$$
\begin{aligned}
\text{Tax}_k &= \theta_I \max\bigl(0,\ B_k - \ell_{k-1}\bigr) \\
\ell_k &= \max\bigl(0,\ \ell_{k-1} - B_k\bigr), \qquad \ell_0 = 0 \\
CF_k &= (1 - \theta_R)\,\text{Rev}_k - O_k - \text{Tax}_k - \text{Repl}_k
\end{aligned}
$$

Limites legais à compensação de prejuízos não são modelados.

### 8.6 Métricas de investimento

$$
\text{NPV}(r) = -K_0 + \sum_{k=1}^{15} \frac{CF_k}{(1 + r)^k}
$$

- **TIR:** a taxa com $\text{NPV} = 0$. É informada como `null` a menos que exista
  exatamente uma raiz acima de $-100\%$, já que as reposições podem mudar o sinal
  dos fluxos mais de uma vez.
- **Payback:** o primeiro ano em que o $CF_k$ acumulado alcança $K_0$, simples e
  descontado a $r$. É `null` se isso nunca acontecer.
- **Capex máximo viável:** o $K$, em BRL do mês da simulação, com
  $\text{NPV} = 0$, mantidos os demais dados. O VPL cai conforme $K$ sobe para
  $r \geq 0$, porque o benefício fiscal da depreciação devolve menos do que cada
  BRL gasto, então uma busca de raiz em intervalo o encontra.
- **Lance mínimo viável (caso C):** o $RF_0$ com $\text{NPV}^{\text{C}} = 0$, em
  BRL/MW-ano na base de maio de 2026. O VPL sobe com $RF_0$. O resultado é
  comparado com o preço inicial do produto (item 10.5.1), e um valor acima dele
  significa que o projeto não pode vencer a esse preço.

### 8.7 O que o contrato adiciona nas bordas

Estes termos não estão nos fluxos-base e aparecem como riscos: a penalidade por
atraso (CRCAP 6.8), as penalidades por desvio de despacho de 1,15 vez a receita
fixa unitária (9.2, 9.3), a penalidade de disponibilidade declarada de 1,1 vez
(9.4), a indisponibilidade programada acima de 2,5% ao ano (5.7.3) e a multa
rescisória de três vezes a receita fixa anual (13.1).
