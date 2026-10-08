# Example project knowledge: design rules

Point a project at this folder (📚 Knowledge) to see how the AI follows project guides.

## Power
- Main supply is **+5V from USB-C**; logic runs at **+3V3**.
- Use the **AMS1117-3.3** (LCSC C6186) LDO with 10 µF input and 22 µF output capacitors.
- Every IC power pin gets a **100 nF** decoupling capacitor placed next to it.

## Components
- Passives are **0603** unless they carry more than 100 mA.
- Prefer **JLCPCB Basic parts** to avoid extended-part fees.
- Status LEDs are **green**, driven through **1 kΩ** resistors.

## Naming
- Name nets in UPPER_SNAKE_CASE (e.g. `LED_STATUS`, `I2C_SDA`).
- Reserve `J1` for the main power/USB connector.
