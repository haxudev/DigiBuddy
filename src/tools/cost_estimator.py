"""Monthly/annual cost projection from an Azure Retail Prices unit price.

CLI:
    python -m cost_estimator --unit-price 0.192 --unit-of-measure "1 Hour" \\
        --quantity 730 --label "D4s v5 VM - East US"
"""

import argparse
import asyncio
from typing import Optional

from pydantic import BaseModel, Field


class CostEstimatorParams(BaseModel):
    unit_price: float = Field(description="Retail price per unit of measure (in USD), as returned by the Azure Retail Prices API retailPrice field")
    unit_of_measure: str = Field(description="The unit of measure for the price, e.g. '1 Hour', '1 GB', '1 Execution', '1 Month'")
    quantity: float = Field(description="Number of units consumed per month, e.g. 730 for a VM running 24/7 (hours), or 1000000 for 1M function executions")
    label: str = Field(default="", description="Optional label for this line item, e.g. 'D4s v5 VM - East US' or 'Azure Functions executions'")


async def cost_estimator(params: CostEstimatorParams) -> str:
    """Estimate monthly and annual Azure costs from a unit price and usage quantity.
    Takes a unit price (from the Azure Retail Prices API), unit of measure, and monthly quantity.
    Returns a formatted cost breakdown with monthly and annual totals."""

    monthly_cost = params.unit_price * params.quantity
    annual_cost = monthly_cost * 12

    label_line = f"**{params.label}**\n" if params.label else ""

    return (
        f"{label_line}"
        f"Unit price:    ${params.unit_price:.6f} per {params.unit_of_measure}\n"
        f"Monthly usage: {params.quantity:,.2f} {params.unit_of_measure}(s)\n"
        f"─────────────────────────────────\n"
        f"Monthly cost:  ${monthly_cost:,.4f}\n"
        f"Annual cost:   ${annual_cost:,.4f}\n"
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="cost_estimator", description=__doc__)
    parser.add_argument("--unit-price", type=float, required=True)
    parser.add_argument("--unit-of-measure", required=True)
    parser.add_argument("--quantity", type=float, required=True)
    parser.add_argument("--label", default="")

    args = parser.parse_args(argv)
    print(
        asyncio.run(
            cost_estimator(
                CostEstimatorParams(
                    unit_price=args.unit_price,
                    unit_of_measure=args.unit_of_measure,
                    quantity=args.quantity,
                    label=args.label,
                )
            )
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
