"""Erros com mensagem segura para mostrar no óculos (sem detalhes internos)."""


class InvalidRequestError(ValueError):
    """Pedido inválido vindo do cliente (formato, ação ou alvo)."""


class AgentError(RuntimeError):
    """Falha esperada do agente: sem rede, varredura em andamento, nome que não resolve..."""


USER_FACING_ERRORS = (InvalidRequestError, AgentError)
