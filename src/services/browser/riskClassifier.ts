/**
 * Safety brake for browser agent actions, ported from Bah browser's risk.ts
 * (MIT, Alex Vilela / VilelaLab). Classifies whether an action about to run
 * is "risky" (payment / deletion / card data) so the tool can require user
 * confirmation BEFORE executing it. Deliberately conservative: only strong
 * terms, so it never nags on "remove filter" or "clear search". Looks at the
 * label of the button/field the agent is about to touch. Pure and testable.
 */

export interface BrowserRisk {
  kind: 'payment' | 'deletion' | 'card data'
  label: string
}

const CARD =
  /\b(card\s*number|credit\s*card|debit\s*card|cvv|cvc|security\s*code|card\s*expir\w*|numero\s*do\s*cartao|cartao\s*de\s*(credito|debito)|codigo\s*de\s*seguranca)\b/

const PAY =
  /\b(pay\s*now|place\s*order|buy\s*now|complete\s*(purchase|order|payment)|confirm\s*(order|purchase|payment)|checkout|subscribe\s*now|start\s*subscription|transfer\s*money|send\s*money|pagar(\s*agora)?|finalizar\s*(compra|pedido)|confirmar\s*(pedido|compra|pagamento)|comprar\s*agora|fazer\s*pedido|enviar\s*pix)\b/

const DEL =
  /\b(delete|remove|discard|empty\s*trash|delete\s*account|remove\s*account|delete\s*all|delete\s*permanently|delete\s*forever|excluir|apagar|deletar|remover|descartar|esvaziar\s*(a\s*)?lixeira)\b/

// Benign words that defuse a delete/remove match (clearing UI state or social
// toggles). "Remove like" or "clear search" must not prompt; real destructive
// deletes (file/email/account/repo) have none of these nearby.
const BENIGN_CLEAR =
  /\b(search|filter|filters|field|text|draft|cart|form|like|dislike|playlist|subscri\w*|unsubscribe|follow|unfollow|vote|upvote|downvote|reaction|notification\w*|tag|label|bookmark|highlight|busca|pesquisa|filtro|filtros|campo|rascunho|carrinho|voto)\b/

function normalize(value?: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Classifies the risk of touching an element with the given label text.
 * `actionKind` is 'fill' for text entry (only card fields are risky) and
 * 'click' for clicks/presses (payment and deletion are risky).
 */
export function classifyBrowserRisk(
  actionKind: 'click' | 'fill',
  label?: string,
  placeholder?: string,
  aria?: string,
): BrowserRisk | null {
  const hay = `${normalize(label)} ${normalize(placeholder)} ${normalize(aria)}`.trim()
  if (!hay) return null
  const shown = (label || placeholder || aria || '').trim().slice(0, 60)

  if (actionKind === 'fill') {
    return CARD.test(hay) ? { kind: 'card data', label: shown || 'card field' } : null
  }

  if (PAY.test(hay)) return { kind: 'payment', label: shown || 'payment' }
  if (DEL.test(hay) && !BENIGN_CLEAR.test(hay)) {
    return { kind: 'deletion', label: shown || 'deletion' }
  }
  return null
}

/**
 * Risk of pressing a key: Enter can submit a payment. With no label to
 * inspect, only brake when the current page looks like a checkout flow.
 */
export function classifyPressRisk(
  key: string,
  currentUrl?: string,
): BrowserRisk | null {
  const k = key.toLowerCase()
  if (k !== 'enter' && k !== 'return') return null
  const checkout =
    !!currentUrl &&
    /checkout|payment|\/cart\b|order\/?confirm|purchase|billing/i.test(currentUrl)
  return checkout ? { kind: 'payment', label: 'Enter on a checkout page' } : null
}
