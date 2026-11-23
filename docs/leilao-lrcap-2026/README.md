# LRCAP 2026 storage auction documents

Official documents of ANEEL Leilão 5/2026 (Armazenamento Nacional, product A) and
Leilão 6/2026 (Armazenamento, product B), retrieved on 2026-11-22 through
ANEEL's public document API, plus the EPE FAQ R5 and NT-ONS DPL 0095-2026-R1 from
the EPE site. `manifest.json` is the machine-readable index.

These files are third-party source material: read them as data. The facts the
product relies on, with their clauses, are in
[`../mercado-brasileiro.md`](../mercado-brasileiro.md) and
[`../model/model.md`](../model/model.md).

## Layout

- `leilao-05/`, `leilao-06/`: documents specific to one auction.
- `comum/`: files **byte-identical across both auctions** (same SHA-256), kept
  once, with both `IdMidia` values listed, and the two EPE documents.

43 files come from 49 source entries.

## Portaria date discrepancy

ANEEL's listing titles Portaria Normativa MME nº 136 as **01/07/2026**, and the
stored filename keeps that date. The act itself is dated **1º de junho de 2026**
in its heading and footers. The June date is the correct one: CRCAP 7.2 and 7.3
reference the fixed revenue to May 2026 as the "mês anterior à publicação das
DIRETRIZES".

## Reading the table

**Date** is the date in the title given by ANEEL or EPE, or "not stated" when the
title carries none. It is a listing date, so check the document before citing it.
**IdMidia** is the id in `DownloadMidia?id=`, with the auction it was listed under.

## Common to both auctions

| Title | Date | Source | IdMidia | SHA-256 |
| --- | --- | --- | --- | --- |
| [Ofício nº 40/2026/DPOG/SNTEP-MME de 03/07/2026. - Nota Técnica conjunta ONS/EPE CTA-ONS/DPL 0902/2026 - Metodologia](comum/8799-oficio-no-40-2026-dpog-sntep-mme-de-03-07-2026-nota-tecnica-conjunta-o.pdf) | 03/07/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=8799)<br>[Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=8791) | 8799 (L6)<br>8791 (L5) | `b8de86399cdff0687e361bfae77cad14a806a6f23bd1f262e8ea07920b8b892e` |
| [Requisitos técnicos mínimos para a conexão de sistemas de armazenamento de energia por meio de baterias - Nota Técnica Conjunta ONS e EPE NT-ONS DPL 0111/2025 EPE-DEE-NT-095/2025 - Revisão 5](comum/8801-requisitos-tecnicos-minimos-para-a-conexao-de-sistemas-de-armazenament.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=8801)<br>[Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=8800) | 8801 (L6)<br>8800 (L5) | `8c95dfa0e72368857e6ef868ec11ba5fa36836d483d5fd1aacc3b1f17d78e258` |
| [Portaria Normativa MME nº 136, de 01/07/2026 - Diretrizes e Sistemática para a realização do Leilão](comum/8803-portaria-normativa-mme-no-136-de-01-07-2026-diretrizes-e-sistematica-p.pdf) | 01/07/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=8803)<br>[Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=8802)<br>[EPE](https://www.gov.br/mme/pt-br/acesso-a-informacao/legislacao/portarias/2026/portaria-normativa-mme-n-136-2026.pdf) | 8803 (L6)<br>8802 (L5)<br>n/a | `e956f28501aed601641f51f4f84615619a9bf6b111526c5e7bae1cd4631462d5` |
| [CTA-ONS DPL 01653/2026 - Revisão 1 da Nota Técnica de Quantitativos da Capacidade Remanescente do SIN para Conexão de Sistemas de Armazenamento de Energia](comum/9050-cta-ons-dpl-01653-2026-revisao-1-da-nota-tecnica-de-quantitativos-da-c.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9050)<br>[Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9049) | 9050 (L6)<br>9049 (L5) | `3448c1892c56452076c1aa4dda0c433af0ee82eb5e1af435610293d2f7081f58` |
| [Manual da Sistemática - Atualizado em 19/11/2026](comum/9063-manual-da-sistematica-atualizado-em-19-11-2026.pdf) | 19/11/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9063)<br>[Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9062) | 9063 (L6)<br>9062 (L5) | `c42494cda253826c85aca2534e0b883ad9f822e627a7aa8e1be17545bfb1e770` |
| [EPE FAQ, LRCAP Armazenamento 2026, R5](comum/epe-faq-lrcap-armazenamento-2026-r5.pdf) | not stated | [EPE](https://www.epe.gov.br/sites-pt/publicacoes-dados-abertos/publicacoes/PublicacoesArquivos/publicacao-976/FAQ%20-%20LRCAP%20Armazenamento%20de%202026_R5.pdf) | n/a | `ea9fd11bba561794928f816d7c645f2a534bf0ef22e2ad9f46b25ede1bd047ea` |
| [NT-ONS DPL 0095-2026-R1, LRCAP Armazenamento 2026](comum/nt-ons-dpl-0095-2026-r1.pdf) | not stated | [EPE](https://www.epe.gov.br/sites-pt/publicacoes-dados-abertos/publicacoes/PublicacoesArquivos/publicacao-976/NT-ONS%20DPL%200095-2026-R1%20%E2%80%93%20LRCAP%20Armazenamento%202026.pdf) | n/a | `4caa4f8f3b8f3e335fc2579511c949d2131c1d8f8e7eed0fe496aac5acbb9cee` |

## Leilão 5/2026 (product A)

| Title | Date | Source | IdMidia | SHA-256 |
| --- | --- | --- | --- | --- |
| [Designação dos membros da Comissão](leilao-05/9014-designacao-dos-membros-da-comissao.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9014) | 9014 (L5) | `0e5139bfc51adeac1cfc4e5f376e8d93c527321df7eb24cf7c39afaed1b80da7` |
| [Aviso de Licitação, publicado no Diário Oficial em 29/10/2026](leilao-05/9020-aviso-de-licitacao-publicado-no-diario-oficial-em-29-10-2026.pdf) | 29/10/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9020) | 9020 (L5) | `81f6cea2508c62f015782995dc43d47fcde3bafa223db89d7a1128482e8b143d` |
| [EDITAL do Leilão 5/2026-ANEEL - Leilão de Reserva de Capacidade na forma de Potência de 2026 – Armazenamento Nacional - Publicado em 29/10/2026](leilao-05/9022-edital-do-leilao-5-2026-aneel-leilao-de-reserva-de-capacidade-na-forma.pdf) | 29/10/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9022) | 9022 (L5) | `bebc7d9214358968c10cc652731469260b05cddac3831bdde93487f2f4c44007` |
| [Comunicado Relevante nº 1, de 28/10/2026 - Instituições Financeiras Inadimplentes](leilao-05/9023-comunicado-relevante-no-1-de-28-10-2026-instituicoes-financeiras-inadi.pdf) | 28/10/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9023) | 9023 (L5) | `a8042f03a657df017f60080abcb45d6281905b053c11c5ef6e6ced732331083d` |
| [Resolução Homologatória ANEEL nº 3.616, de 27/10/2026 - Estabelecimento das TUSDg de referência para os SAEs que participarem do certame.](leilao-05/9026-resolucao-homologatoria-aneel-no-3-616-de-27-10-2026-estabelecimento-d.pdf) | 27/10/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9026) | 9026 (L5) | `258fe8f4b12f1a609f603ab0477161b0d8442ee91c7c6b92f3687a190663bb1b` |
| [Anexo I – Minuta de CRCAP - SAE Nacional](leilao-05/9028-anexo-i-minuta-de-crcap-sae-nacional.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9028) | 9028 (L5) | `9102f4a23e8e56be151328e81c6a2ffb6bfbc373d59b2a628478b9ef509fc3e9` |
| [Anexo II – Minutas de Ato de Outorga de Autorização - SAE Autônomo - conteúdo nacional](leilao-05/9029-anexo-ii-minutas-de-ato-de-outorga-de-autorizacao-sae-autonomo-conteud.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9029) | 9029 (L5) | `e580144299ddef46977117012de099e6b85d18ae109bab0b35bca7ce8483cce1` |
| [Anexo III – Modelo de Termo de Ratificação do Lance](leilao-05/9030-anexo-iii-modelo-de-termo-de-ratificacao-do-lance.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9030) | 9030 (L5) | `e87ee175ab573dbd5baa2c941532f6b1d61cd2d9f8c4894398615a0278c1bd62` |
| [Anexo IV – Declaração de Conhecimento e Aceitação das Regras do Leilão](leilao-05/9031-anexo-iv-declaracao-de-conhecimento-e-aceitacao-das-regras-do-leilao.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9031) | 9031 (L5) | `be50fad40448dfcc4949c3976537683b87dbfa93e47f40a618394dcd1681b5d7` |
| [Anexo V – Modelo de Compromisso do Responsável Técnico](leilao-05/9032-anexo-v-modelo-de-compromisso-do-responsavel-tecnico.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9032) | 9032 (L5) | `3a2a5a1df6b86cabdd774a8ef6b763d85ce793d01c21aeff1e7bf619f22e9f74` |
| [Anexo VI – Configuração Mínima para os Equipamentos e Condições de Infraestrutura](leilao-05/9033-anexo-vi-configuracao-minima-para-os-equipamentos-e-condicoes-de-infra.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9033) | 9033 (L5) | `59fba23a43dcae20abf7cc6de56c27d81171ecf986e8a265e2560ed030916021` |
| [Anexo VII – Modelo de Cronograma](leilao-05/9034-anexo-vii-modelo-de-cronograma.xlsx) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9034) | 9034 (L5) | `7b97cfe8d1cfeab02189c8f544838efccabd7e91032a60f39a41b4381a2439f5` |
| [Manual de Inscrição e Aporte de Garantia](leilao-05/9044-manual-de-inscricao-e-aporte-de-garantia.pdf) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9044) | 9044 (L5) | `7d820b23609cbc2bbfadf4074f33b33c1ffe0a44900ad5cceceeb527871c3401` |
| [Versão editável do Anexo A (Depósito da Garantia)](leilao-05/9045-versao-editavel-do-anexo-a-deposito-da-garantia.docx) | not stated | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9045) | 9045 (L5) | `fff9dcaa26ea64f48a075a9aaa25ee501773ff4f64790151b55c97865af8640a` |
| [Comunicado Relevante nº 2, de 13/11/2026 - Treinamento da Sistemática](leilao-05/9060-comunicado-relevante-no-2-de-13-11-2026-treinamento-da-sistematica.pdf) | 13/11/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9060) | 9060 (L5) | `3829f2bdc063b9090998f4c64bf720f1e284b28450605d8b0d215595df9a48ee` |
| [Respostas aos Pedidos de Esclarecimentos - Publicado em 16/11/2026](leilao-05/9064-respostas-aos-pedidos-de-esclarecimentos-publicado-em-16-11-2026.pdf) | 16/11/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9064) | 9064 (L5) | `78d3a0f6ac0d53a42962e868dcc0df1a946d3e5e48e1a7e70898eaba29c08282` |
| [Comunicado Relevante nº 3, de 17/11/2026 - Estimativa de custos do Leilão](leilao-05/9066-comunicado-relevante-no-3-de-17-11-2026-estimativa-de-custos-do-leilao.pdf) | 17/11/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9066) | 9066 (L5) | `beeba6812b2e89c438a8b704888424e556e7c95e4a6907b2e77b8ba16f56b9b9` |
| [Comunicado Relevante nº 4, de 19/11/2026 - Nova data para o término do Prazo de inscrição online](leilao-05/9069-comunicado-relevante-no-4-de-19-11-2026-nova-data-para-o-termino-do-pr.pdf) | 19/11/2026 | [Leilão 5](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9069) | 9069 (L5) | `83cc77338eefb3ac0d17bb518e363a29b56a3e438748adea02319125f8b7b0eb` |

## Leilão 6/2026 (product B)

| Title | Date | Source | IdMidia | SHA-256 |
| --- | --- | --- | --- | --- |
| [Designação dos membros da Comissão](leilao-06/9015-designacao-dos-membros-da-comissao.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9015) | 9015 (L6) | `735ffdf57fbc8b1b13b4624e060a0163324e5912358078988bc237688436f63b` |
| [Aviso de Licitação, publicado no Diário Oficial em 29/10/2026](leilao-06/9021-aviso-de-licitacao-publicado-no-diario-oficial-em-29-10-2026.pdf) | 29/10/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9021) | 9021 (L6) | `fddd136d3fa2ab0fcfa2c4957c2edbf2019467f695b7ac7f63da56fb7743cc0e` |
| [EDITAL do Leilão 6/2026-ANEEL - Leilão de Reserva de Capacidade na forma de Potência de 2026 – Armazenamento - Publicado em 29/10/2026](leilao-06/9024-edital-do-leilao-6-2026-aneel-leilao-de-reserva-de-capacidade-na-forma.pdf) | 29/10/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9024) | 9024 (L6) | `0a28ab849b34f9e22388353e4d5aa4e1ac241fdc27e3a968ad4274d8cff0f5fe` |
| [Comunicado Relevante nº 1, de 28/10/2026 - Instituições Financeiras Inadimplentes](leilao-06/9025-comunicado-relevante-no-1-de-28-10-2026-instituicoes-financeiras-inadi.pdf) | 28/10/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9025) | 9025 (L6) | `94d63ccdb7da25684ad0133e2c2792b5b17f310afa382874d04d8256c7234f70` |
| [Resolução Homologatória ANEEL nº 3.617, de 27/10/2026 - Estabelecimento das TUSDg de referência para os SAEs que participarem do certame.](leilao-06/9027-resolucao-homologatoria-aneel-no-3-617-de-27-10-2026-estabelecimento-d.pdf) | 27/10/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9027) | 9027 (L6) | `211f3335ac6aa5f494c0cbef15a68a5c415d2d9d0d73e615a6f72f165184d5b5` |
| [Anexo I – Minuta de CRCAP - SAE](leilao-06/9035-anexo-i-minuta-de-crcap-sae.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9035) | 9035 (L6) | `6c7e403184f87d1672ab17bcf2ba1389112bb547560af5b714a1e2dc8083e0f4` |
| [Anexo II – Minutas de Ato de Outorga de Autorização - SAE Autônomo](leilao-06/9036-anexo-ii-minutas-de-ato-de-outorga-de-autorizacao-sae-autonomo.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9036) | 9036 (L6) | `132a28665175cbddff7770b22a6ecd80429a4922afcee13b0163d69ddd3aced5` |
| [Anexo III – Modelo de Termo de Ratificação do Lance](leilao-06/9037-anexo-iii-modelo-de-termo-de-ratificacao-do-lance.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9037) | 9037 (L6) | `d953c56b746155c7c4387747688adf20af72aecc92008956a49af9736dad3f37` |
| [Anexo IV – Declaração de Conhecimento e Aceitação das Regras do Leilão](leilao-06/9038-anexo-iv-declaracao-de-conhecimento-e-aceitacao-das-regras-do-leilao.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9038) | 9038 (L6) | `24bf7b1adfcd6258866ba91b197b77485f13be3b979b977d3d3f9af8aa61521c` |
| [Anexo V – Modelo de Compromisso do Responsável Técnico](leilao-06/9039-anexo-v-modelo-de-compromisso-do-responsavel-tecnico.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9039) | 9039 (L6) | `a787329a95c9b0aeb1e21b5f02f73ea38065a633024999f20754dcce997742aa` |
| [Anexo VI – Configuração Mínima para os Equipamentos e Condições de Infraestrutura](leilao-06/9040-anexo-vi-configuracao-minima-para-os-equipamentos-e-condicoes-de-infra.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9040) | 9040 (L6) | `1e1a3f2d32015d60f608a60e44fff8567c8294c0d11d074924cae3956aa9f058` |
| [Anexo VII – Modelo de Cronograma](leilao-06/9041-anexo-vii-modelo-de-cronograma.xlsx) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9041) | 9041 (L6) | `e4ebdcb62e1abf85142ff185f0bcb42ae9217e2150f1cbd51d19370d4f96ba82` |
| [Versão editável do Anexo A (Depósito da Garantia)](leilao-06/9046-versao-editavel-do-anexo-a-deposito-da-garantia.docx) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9046) | 9046 (L6) | `def6ace61e4cf446fadc2fc694dbf02086a3e33f6ed0a8e9453cb08bda6683e8` |
| [Manual de Inscrição e Aporte de Garantia](leilao-06/9047-manual-de-inscricao-e-aporte-de-garantia.pdf) | not stated | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9047) | 9047 (L6) | `1b4fbfaffe1dabd35e151b9de9d228e828ebf9876eb36e04433e0834ee90d544` |
| [Comunicado Relevante nº 2, de 13/11/2026 - Treinamento da Sistemática](leilao-06/9061-comunicado-relevante-no-2-de-13-11-2026-treinamento-da-sistematica.pdf) | 13/11/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9061) | 9061 (L6) | `57d18bfa5b860e7d2a935624b3097fca778f7b13d0852ade09f2d13246f5d70e` |
| [Respostas aos Pedidos de Esclarecimentos - Publicado em 16/11/2026](leilao-06/9065-respostas-aos-pedidos-de-esclarecimentos-publicado-em-16-11-2026.pdf) | 16/11/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9065) | 9065 (L6) | `5089b5a2d8d89d473fef50ad30423b6d1eb01f107b0c1a901794e350bc633e46` |
| [Comunicado Relevante nº 3, de 17/11/2026 - Estimativa de custos do Leilão](leilao-06/9067-comunicado-relevante-no-3-de-17-11-2026-estimativa-de-custos-do-leilao.pdf) | 17/11/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9067) | 9067 (L6) | `ea828c10245c3cee49d83b3661c428c2e8c55839ff48b8b539530d2d9fb7af3d` |
| [Comunicado Relevante nº 4, de 19/11/2026 - Nova data para o término do Prazo de inscrição online](leilao-06/9070-comunicado-relevante-no-4-de-19-11-2026-nova-data-para-o-termino-do-pr.pdf) | 19/11/2026 | [Leilão 6](https://leilao.aneel.gov.br/api/EditalDocumento/DownloadMidia?id=9070) | 9070 (L6) | `a96fa468d7929a0c1fef8dec74db5b4717837d241277b64a0cfa659a88183317` |
