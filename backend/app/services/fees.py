"""Cálculo único de lo que paga el comprador y lo que recibe el organizador.

La misma función alimenta la vista previa del panel y el cobro real. Si las
dos fórmulas viven separadas, la simulación miente tarde o temprano.
"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class FeeBreakdown:
    base_cents: int
    discount_cents: int
    service_fee_cents: int
    payment_fee_cents: int
    tax_cents: int
    platform_fee_cents: int
    buyer_total_cents: int
    organizer_net_cents: int
    platform_fee_payer: str

    def as_dict(self) -> dict:
        return asdict(self)


def compute_fees(
    *,
    base_cents: int,
    discount_cents: int = 0,
    service_fee_cents: int = 0,
    payment_fee_pct: float = 0,
    tax_pct: float = 0,
    platform_fee_bps: int = 0,
    platform_fee_fixed_cents: int = 0,
    platform_fee_payer: str = "organizer",
) -> FeeBreakdown:
    """Calcula el desglose de una boleta.

    El cupón descuenta la boleta, no los cargos. El servicio lo define el
    organizador y se suma a su neto. La comisión de pago y el impuesto son
    costos del comprador. La comisión de Enty se cobra al organizador o al
    comprador según `platform_fee_payer`, nunca a ambos.
    """
    base = max(int(base_cents) - max(int(discount_cents), 0), 0)
    service = max(int(service_fee_cents), 0)
    base_for_pct = base + service
    payment = round(base_for_pct * float(payment_fee_pct or 0) / 100)
    tax = round(base_for_pct * float(tax_pct or 0) / 100)
    platform = round(base * int(platform_fee_bps or 0) / 10000) + max(
        int(platform_fee_fixed_cents or 0), 0
    )
    # Una comisión nunca puede dejar al organizador debiendo plata por vender.
    platform = min(platform, base + service)
    payer = platform_fee_payer if platform_fee_payer in ("organizer", "buyer") else "organizer"
    buyer_total = base + service + payment + tax + (platform if payer == "buyer" else 0)
    organizer_net = base + service - (platform if payer == "organizer" else 0)
    return FeeBreakdown(
        base_cents=base,
        discount_cents=max(int(discount_cents), 0),
        service_fee_cents=service,
        payment_fee_cents=payment,
        tax_cents=tax,
        platform_fee_cents=platform,
        buyer_total_cents=buyer_total,
        organizer_net_cents=organizer_net,
        platform_fee_payer=payer,
    )
