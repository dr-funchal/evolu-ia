# ADR 0011 — Administração da equipe, convites e plataforma multi-tenant

- **Status:** aceito (29/09/2026)
- **Contexto:** o uso real exige que o gestor da equipe cadastre hospitais e serviços e convide
  médicos e secretárias por e-mail, e que a ferramenta já nasça multi-tenant para atender outras
  equipes. A identidade é do Zitadel; o sistema não guarda senhas.
- **Decisão:**
  - **Dois níveis de administração.** Operadores da **plataforma** (`app.platform_admins`, sem
    política RLS, acessível só por funções `security definer`, designados por CLI com o papel
    dono) criam tenants via `app.platform_create_tenant`. O **administrador da equipe**
    (`tenant_admin`, capacidade `org.manage`) gerencia hospitais, serviços e membros do seu tenant.
    `app.is_platform_admin()` exige usuário real = atuante (persona nunca é operador).
  - **Escrita pela RLS.** Hospitais, especialidades e serviços são inseridos/atualizados pelo papel
    `evolu_app` com políticas `app.has_cap(tenant, null, 'org.manage')`; colunas atualizáveis
    restritas por `GRANT (colunas)`. Desativar em vez de apagar (`active`), pois há histórico
    clínico apontando para eles; serviço ou hospital inativo some de `my_service_capabilities()`.
  - **Convite ligado à identidade.** A API autoriza primeiro (`org.manage`) e só então usa um
    usuário de serviço do Zitadel (PAT, `ORG_USER_MANAGER`) para achar a conta pelo e-mail ou
    criá-la (sem senha) e gerar um código de convite. O vínculo e os papéis são gravados contra
    `issuer + subject` (`app.admin_provision_member`), nunca contra o e-mail; no primeiro login,
    `auth_login` encontra a identidade pré-cadastrada. Conta "pendente" = sem nenhum método de
    autenticação no IdP. Entrega: `INVITE_DELIVERY=link` (o admin envia o link) ou `email`
    (Zitadel envia; exige SMTP).
  - **Salvaguardas.** Não revogar o último `tenant_admin`; não suspender o próprio vínculo;
    papéis `tenant_admin` e `finance` só valem para a equipe inteira; serviço exige hospital do
    mesmo tenant. `tenant_admin` **não** tem leitura clínica: para atender, o admin concede a si
    um papel clínico num serviço. Auditoria registra ação e identificadores, nunca e-mail/nome.
- **Consequências:** o PAT do usuário de serviço é segredo de produção (expira em 2027-09-29;
  renovar antes). Sem SMTP, o convite depende de o admin repassar o link. Depois do cadastro o
  login v2 do Zitadel termina em "Você está conectado" sem redirecionar: o convidado precisa
  abrir `evolu-ia.pulpfy.com` (o texto do convite avisa).

## Adendo (29/09/2026) — módulos opcionais por equipe

Passagens de caso passou a ser opcional (`app.tenants.handoffs_enabled`, padrão `false`, migration
0007), ligado/desligado pelo administrador da equipe. O controle fica num ponto só:
`app.user_has_cap` nega `handoff.participate` quando o módulo está desligado, e daí derivam a RLS
das tabelas de passagem, as checagens da API, o contexto da interface e a revalidação do worker.
Desligar não apaga dados. Ligar/desligar é auditado (`admin.module.handoffs.enable|disable`).
