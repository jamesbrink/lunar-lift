#!/usr/bin/env python3
"""
LUNAR LIFT reference math — the numbers quoted in docs/reference/*.md.

Every input here is transcribed from a primary source cited in the docs
(NASA planetary fact sheets, NASA SP-4029 "Apollo by the Numbers" tables,
Rocketdyne F-1/J-2 specification tables). Run it to reproduce the tables:

    python3 tools/mission-math.py

Units: km and s for orbital mechanics, then m/s when printed as "m/s".
"""
import math

G0 = 9.80665               # m/s^2, standard gravity (Isp -> exhaust velocity)
LB = 0.45359237            # kg per pound-mass
NMI = 1.852                # km per nautical mile
FT = 0.0003048             # km per foot

MU_E = 398600.4418         # km^3/s^2  Earth GM      (NASA Earth fact sheet)
MU_M = 4902.8              # km^3/s^2  Moon  GM      (NASA Moon fact sheet, 0.00490e6)
R_E = 6371.0               # km        Earth mean radius
R_M = 1737.4               # km        Moon  mean radius
MOON_A = 384400.0          # km        Moon semi-major axis
MOON_MASS_RATIO = 0.07346 / 5.9722
SIDEREAL_DAY = 86164.0905  # s         Earth sidereal rotation period


def ve(isp):               # exhaust velocity, km/s
    return isp * G0 / 1000.0


def orbit(r_km):
    """circular speed (km/s) and period (min) at radius r_km"""
    return math.sqrt(MU_E / r_km), 2 * math.pi * math.sqrt(r_km ** 3 / MU_E) / 60


def heading(text):
    print()
    print("=" * 74)
    print(text)
    print("=" * 74)


# ───────────────────────────────────────────────────────── 1. reference speeds
heading("1. CIRCULAR / ESCAPE SPEEDS (two-body, mean radii)")
for h in (0, 100, 185, 191, 400, 1000):
    v, T = orbit(R_E + h)
    print(f"  Earth circular @{h:>4} km : {v*1000:8.1f} m/s   period {T:6.2f} min")
print(f"  Earth escape @surface : {math.sqrt(2*MU_E/R_E)*1000:8.1f} m/s   (fact sheet: 11.186 km/s)")
print(f"  Earth surface gravity : {MU_E/R_E**2*1000:8.3f} m/s^2 (fact sheet: 9.820 mean)")
for h in (15, 60, 100, 185):
    r = R_M + h
    print(f"  Moon  circular @{h:>4} km : {math.sqrt(MU_M/r)*1000:8.1f} m/s   "
          f"period {2*math.pi*math.sqrt(r**3/MU_M)/60:6.2f} min")
print(f"  Moon  escape @surface : {math.sqrt(2*MU_M/R_M)*1000:8.1f} m/s   (fact sheet: 2.38 km/s)")
print(f"  Moon  surface gravity : {MU_M/R_M**2*1000:8.3f} m/s^2 (fact sheet: 1.62)")
print(f"  Moon  orbital speed   : {math.sqrt(MU_E/MOON_A)*1000:8.1f} m/s   (fact sheet: 1.022 km/s)")
print(f"  Moon  sphere of influence: {MOON_A*MOON_MASS_RATIO**0.4:6.0f} km  (r = a (m/M)^(2/5); game uses 66200)")

# ─────────────────────────────────────────── 2. Apollo 11 parking orbit checks
heading("2. APOLLO 11 PARKING ORBIT (SP-4029 Ascent / Earth Orbit Phase tables)")
v_eoi = 25567.9 * FT * 1000          # m/s, space-fixed at earth orbit insertion
alt_eoi = 103.176 * NMI              # km
apo, per = 100.4 * NMI, 98.9 * NMI
a_park = R_E + (apo + per) / 2
print(f"  earth orbit insertion: {alt_eoi:.1f} km, {v_eoi:.1f} m/s space-fixed")
print(f"    circular speed at that radius        : {math.sqrt(MU_E/(R_E+alt_eoi))*1000:.1f} m/s")
print(f"    100.4 x 98.9 nmi ellipse: a={a_park:.0f} km, T={2*math.pi*math.sqrt(a_park**3/MU_E)/60:.2f} min (table: 88.18)")
print(f"    vis-viva at apogee                   : {math.sqrt(MU_E*(2/(R_E+apo)-1/a_park))*1000:.1f} m/s")
v_rot = 2 * math.pi * R_E * math.cos(math.radians(28.6084)) / SIDEREAL_DAY * 1000
print(f"  Earth rotation credit @28.6084 deg N   : {v_rot:.1f} m/s   (table liftoff space-fixed: {1340.7*FT*1000:.1f})")
f_flat = 1 - 6356.752 / 6378.137
gc = math.degrees(math.atan((1 - f_flat) ** 2 * math.tan(math.radians(28.6084))))
print(f"  LC-39 geodetic 28.6084 -> geocentric   : {gc:.4f} deg (table liftoff: 28.4470)")

# ───────────────────────────────── 3. Apollo 11 ideal delta-v, real hardware
heading("3. APOLLO 11 IDEAL DELTA-V BUDGET (SP-4029 Ground Ignition Weights)")
t = LB / 1000.0                     # tonnes per lbm
m_tot = 6477875 * t
sic_prop = (3305786 + 1424889) * t      # S-IC oxidizer + fuel
sic_dry = 287531 * t
is1 = 11477 * t
sii_prop = (819050 + 158116) * t
sii_dry = 79714 * t
is2 = 8076 * t
sivb_prop = (192497 + 43608) * t
iu, sc = 4275 * t, 109646 * t           # instrument unit, spacecraft stack
print(f"  ignition mass {m_tot:.1f} t   S-IC {sic_prop+sic_dry:.1f} t  "
      f"S-II {sii_prop+sii_dry:.1f} t  S-IVB {sivb_prop+24852*t:.1f} t  spacecraft+IU {sc+iu:.1f} t")

SIVB_T1, SIVB_T2 = 147.13, 346.83       # s, first and second burn durations
p1 = sivb_prop * SIVB_T1 / (SIVB_T1 + SIVB_T2)
p2 = sivb_prop - p1


def budget(m0, stages, label):
    """stages: (isp_s, propellant_burned_t, mass_jettisoned_at_staging_t)"""
    m, total, rows = m0, 0.0, []
    for isp, prop, disc in stages:
        e = ve(isp)
        d = e * math.log(m / (m - prop))
        rows.append((isp, prop, d, m, m - prop - disc))
        total += d
        m -= prop + disc
    print(f"  {label}")
    for isp, prop, d, m0_, m1_ in rows:
        print(f"    Isp {isp:5.1f} s  prop {prop:7.1f} t  dv {d*1000:7.0f} m/s   {m0_:7.1f} -> {m1_:7.1f} t")
    print(f"    total {total*1000:.0f} m/s, remaining mass {m:.1f} t")
    return total


dv_sl = budget(m_tot, [(263.0, sic_prop, sic_dry + is1),
                       (421.0, sii_prop, sii_dry + is2),
                       (421.0, p1, 0.0)],
               "pad -> earth orbit insertion, S-IC at SEA-LEVEL Isp (lower bound)")
dv_vac = budget(m_tot, [(304.1, sic_prop, sic_dry + is1),
                        (421.0, sii_prop, sii_dry + is2),
                        (421.0, p1, 0.0)],
                "pad -> earth orbit insertion, S-IC at VACUUM Isp (upper bound)")
gain = v_eoi - 1340.7 * FT * 1000
print(f"  measured speed gain pad->EOI      : {gain:.1f} m/s")
print(f"  => drag + gravity + steering loss : {dv_sl*1000-gain:.0f} .. {dv_vac*1000-gain:.0f} m/s")
print(f"  S-IC liftoff TWR                  : {5*6770/(m_tot*G0):.3f}   "
      f"propellant flow {sic_prop/168.03:.2f} t/s")
m_at_tli = m_tot - (sic_prop + sic_dry + is1 + sii_prop + sii_dry + is2 + p1)
tli_ideal = ve(421.0) * math.log(m_at_tli / (m_at_tli - p2))
print(f"  TLI ideal (S-IVB 2nd burn, {p2:.1f} t) : {tli_ideal*1000:.0f} m/s   (SP-4029 measured: {10008.1*FT*1000:.0f})")

tli = 10008.1 * FT * 1000
loi = 2917.5 * FT * 1000
circl = 158.8 * FT * 1000
asc = 6070.1 * FT * 1000
pdi = 5564.9 * FT * 1000
print(f"  LOI {loi:.0f}  circularise {circl:.0f}  LM lunar ascent {asc:.0f}  (SP-4029, m/s)")
print(f"  LM powered-descent initiation     : {pdi:.1f} m/s at {6.4*NMI:.1f} km")
asc_gross = (4700 + 5200 + 600) * t          # ascent stage loaded, extended LM
print(f"  LM descent-stage capability       : {ve(311)*math.log((19500*t+asc_gross)/asc_gross)*1000:.0f} m/s "
      f"(Isp 311 s; Apollo 11 LM gross {33278*t:.1f} t)")

# ────────────────────────────────────────── 4. trans-lunar patched conics
heading("4. TRANS-LUNAR TRANSFER (patched conics, copircular approximation)")
r1 = R_E + 185.0
v1 = math.sqrt(MU_E / r1)
a_h = (r1 + MOON_A) / 2
v_p = math.sqrt(MU_E * (2 / r1 - 1 / a_h))
print(f"  from a 185 km circular orbit (r = {r1:.0f} km, v = {v1*1000:.1f} m/s):")
print(f"    minimum-energy (Hohmann) perigee speed : {v_p*1000:.1f} m/s -> impulsive TLI {(v_p-v1)*1000:.1f} m/s")
print(f"    transfer time (half period)            : {math.pi*math.sqrt(a_h**3/MU_E)/3600:.1f} h")
v_arr = math.sqrt(MU_E * (2 / MOON_A - 1 / a_h))
v_moon = math.sqrt(MU_E / MOON_A)
v_inf = v_moon - v_arr
print(f"    arrival Earth-frame speed              : {v_arr*1000:.1f} m/s vs Moon {v_moon*1000:.1f} m/s")
print(f"    hyperbolic excess w.r.t. Moon          : {v_inf*1000:.1f} m/s")
r_p = R_M + 111.0
v_peri = math.sqrt(v_inf ** 2 + 2 * MU_M / r_p)
print(f"    periselene ({111:.0f} km) speed          : {v_peri*1000:.1f} m/s; circular there "
      f"{math.sqrt(MU_M/r_p)*1000:.1f} -> LOI {(v_peri-math.sqrt(MU_M/r_p))*1000:.0f} m/s (Apollo 11 measured 889)")
# TLI state, SP-4029 translunar table: 180.581 nmi, 35,545.6 ft/s, flight path angle 7.367 deg
r_t = R_E + 180.581 * NMI
v_t = 35545.6 * FT * 1000 / 1000          # km/s
fpa = math.radians(7.367)
eps = v_t ** 2 / 2 - MU_E / r_t
a_t = -MU_E / (2 * eps)
h_t = r_t * v_t * math.cos(fpa)
e_t = math.sqrt(max(0.0, 1 - (h_t ** 2 / MU_E) / a_t))
print(f"  Apollo 11 right after TLI: r = {r_t:.0f} km, v = {v_t:.3f} km/s, FPA = {math.degrees(fpa):.3f} deg")
print(f"    Earth-relative orbit: a = {a_t:.0f} km, e = {e_t:.4f}, "
      f"perigee {a_t*(1-e_t):.0f} km, apogee {a_t*(1+e_t):.0f} km")
print(f"    apogee is far beyond the Moon -> Apollo flew a fast (~73 h) transfer, not the 120 h minimum")
print(f"  game targeting: burn prograde until v = sqrt(MU_E (2/r - 1/aT)) with aT = (r + MOON_DIST)/2")

# ─────────────────────────────────────────────── 5. one-way mission budget
heading("5. MISSION REQUIREMENT: PAD -> LUNAR SURFACE (Apollo 11 class, ideal)")
items = [
    ("pad -> 185 km parking orbit", dv_sl * 1000, "Apollo 11 hardware, sea-level Isp accounting"),
    ("trans-lunar injection", tli, "SP-4029 measured"),
    ("lunar orbit insertion", loi, "SP-4029 measured"),
    ("circularise at 60 nmi", circl, "SP-4029 measured"),
    ("deorbit + powered descent", 2300.0, "PDI 1696 m/s + gravity losses; < LM's 3202 m/s budget"),
]
total = 0.0
for name, d, why in items:
    total += d
    print(f"  {name:<32} {d:7.0f}   running {total:7.0f}   # {why}")
print(f"  ONE-WAY REQUIREMENT              {total:7.0f} m/s")
print(f"  + lunar ascent {asc:.0f} + TEI ~1100 -> round trip {total+asc+1100:.0f} m/s")

# ──────────────────────────────────────────────────────── 6. game stacks
heading("6. GAME VEHICLE IDEAL DELTA-V vs REQUIREMENT")
CAPSULE = 10.0


def game_stack(specs, label, requirement):
    m0 = sum(d + f for _, d, f, _, _ in specs) + CAPSULE
    m, total = m0, 0.0
    print(f"  {label}: ignition mass {m0:.0f} t, final mass {CAPSULE:.0f} t")
    for name, dry, prop, thr, isp in specs:
        e = ve(isp)
        d = e * math.log(m / (m - prop))
        twr = thr / (m * G0)              # kN / (t * m/s^2) = 1/s * s ... dimensionless
        burn = prop * e * 1000 / thr      # t * (km/s) / kN -> s  (1 kN = 1 t*m/s^2)
        total += d
        m -= prop + dry
        print(f"    {name:<14} TWR {twr:5.2f}  burn {burn:5.0f} s  dv {d*1000:6.0f} m/s  -> {m:7.1f} t")
    print(f"    ideal total {total*1000:.0f} m/s   vs one-way requirement {requirement:.0f} m/s"
          f"   margin {(total*1000)/requirement:.2f}x")
    return total


SHIPPED = [("S-1 SATURN I", 130, 1800, 46000, 304),
           ("S-2 SATURN II", 90, 1200, 16000, 415),
           ("CSM ENGINE", 18, 185, 400, 420)]
PREVIOUS = [("S-1 SATURN I", 130, 2400, 46000, 263),
            ("S-2 SATURN II", 120, 700, 12000, 340),
            ("CSM ENGINE", 20, 400, 3000, 420)]
NOVA = [("S-1 SATURN I", 130, 3000, 70000, 330),
        ("S-2 SATURN II", 110, 1500, 22000, 430),
        ("CSM ENGINE", 25, 700, 6000, 460)]
game_stack(SHIPPED, "js/constants.js SPECS (shipped; flies, see mission-design.md)", total)
game_stack(PREVIOUS, "SPECS as they were (reached lunar orbit, landed at 1233 m/s dry)", total)
game_stack(NOVA, "NOVA candidate (oversized: nothing to spend the margin on)", total)
print("  NOTE: ideal budget only — no gravity, drag, steering, or the fact that a lander")
print("        must keep propellant back for the descent. tools/mission-sim.mjs flies the")
print("        mission through the shipped physics and reports what it actually costs.")

# ────────────────────────────────────────────────────────── 7. atmosphere
heading("7. ATMOSPHERE: U.S. STANDARD ATMOSPHERE 1976 vs THE GAME'S MODEL")
# geopotential base of each USSA-1976 layer: h km, T K, p Pa, lapse rate K/km
LAYERS = [(0, 288.15, 101325.0, -6.5), (11, 216.65, 22632.0, 0.0), (20, 216.65, 5474.89, 1.0),
          (32, 228.65, 868.02, 2.8), (47, 270.65, 110.91, 0.0), (51, 270.65, 66.939, -2.8),
          (71, 214.65, 3.9564, -2.0)]
G_STD, R_D = 9.80665, 287.0528731     # m/s^2, J/(kg K)


# MSISE-90 mean-solar-activity densities above the 1976 table's 86 km limit
UPPER = [(86, 5.704e-6), (100, 5.08e-7), (120, 1.80e-8), (150, 1.73e-9),
         (200, 2.41e-10), (250, 5.97e-11), (300, 1.87e-11), (400, 2.62e-12), (600, 9.89e-14)]


def rho_usa(h_km):
    """Density in kg/m^3: USSA-1976 layers to 86 km, MSISE-90 mean log-linear above."""
    hb, Tb, pb, L = LAYERS[0]
    for cand in LAYERS:
        if cand[0] <= h_km:
            hb, Tb, pb, L = cand
    if h_km > LAYERS[-1][0]:
        if h_km > UPPER[-1][0]:
            return 0.0
        for (h0, r0), (h1, r1) in zip(UPPER, UPPER[1:]):
            if h0 <= h_km <= h1:
                f = (h_km - h0) / (h1 - h0)
                return math.exp(math.log(r0) + f * (math.log(r1) - math.log(r0)))
    L_m = L / 1000.0                  # K/m
    dh = (h_km - hb) * 1000.0
    T = Tb + L_m * dh
    p = pb * math.exp(-G_STD * dh / (R_D * Tb)) if L == 0 else pb * (T / Tb) ** (-G_STD / (R_D * L_m))
    return p / (R_D * T)


print(f"  {'alt km':>7} {'exp(-h/8.5)':>12} {'USSA-1976':>12} {'game/real':>10}")
for h in (0, 7.84, 11, 13.57, 20, 25, 32, 47, 60, 66.1, 71, 80, 86):
    g = 1.225 * math.exp(-h / 8.5)
    u = rho_usa(h)
    print(f"  {h:7.2f} {g:12.3e} {u:12.3e} {g/u:10.2f}")
print("  7.84 km = Apollo 11 Mach 1, 13.57 km = max-q, 66.1 km = S-IC OECO altitude")
print(f"  scale height implied by USSA-1976 at sea level: "
      f"{R_D*288.15/G_STD/1000:.2f} km; at 11 km: {R_D*216.65/G_STD/1000:.2f} km")
for h in (100, 120, 150, 200, 300, 400):
    g = 1.225 * math.exp(-h / 8.5)
    print(f"  {h:7.0f} {g:12.3e} {rho_usa(h):12.3e} {g/rho_usa(h):10.2e}")
print("  100-400 km: MSISE-90 mean solar activity (braeunig.us table).")
print("  js/physics.js airDensity() = 1.225 exp(-h/8.5) below 420 km, 0 above:")
print("    too dense 20-160 km, too thin above ~180 km, hard cut at 420 km.")


# ────────────────────────────── 8. stage-by-stage measured gains, and a drag bound
heading("8. WHERE THE ASCENT DELTA-V ACTUALLY GOES (SP-4029 state rows)")
# verified space-fixed speeds: pad (rotation credit), S-IC OECO, S-II OECO, S-IVB cutoff
# (label, v before, v after m/s, Isp SL, Isp vac, propellant t, stage-start mass t)
ROWS = [("S-IC   pad -> OECO 161.63 s", 408.6, 2764.1, ve(263.0), ve(304.1), sic_prop, 2938.3),
        ("S-II   ignition -> OECO 548.22 s", 2773.9, 6916.2, ve(421.0), ve(421.0), sii_prop, 656.9),
        ("S-IVB  1st burn -> cutoff 699.33 s", 6919.0, 7793.4, ve(421.0), ve(421.0), p1, 173.8)]
print(f"  {'stage':<34} {'measured':>9} {'ideal SL':>9} {'ideal vac':>10} {'loss SL':>8} {'loss vac':>9}")
tot_meas = tot_sl = tot_vac = 0.0
for name, v0, v1, e_sl, e_vac, prop, m0_row in ROWS:
    m0 = m0_row
    d_sl = e_sl * math.log(m0 / (m0 - prop)) * 1000
    d_vac = e_vac * math.log(m0 / (m0 - prop)) * 1000
    gain = v1 - v0
    tot_meas += gain; tot_sl += d_sl; tot_vac += d_vac
    print(f"  {name:<34} {gain:8.0f}  {d_sl:8.0f}  {d_vac:9.0f} {d_sl-gain:8.0f} {d_vac-gain:9.0f}")
print(f"  {'total pad -> earth orbit insertion':<34} {tot_meas:8.0f}  {tot_sl:8.0f}  {tot_vac:9.0f}"
      f" {tot_sl-tot_meas:8.0f} {tot_vac-tot_meas:9.0f}")
print("  stage-start masses are the section-3 chain (which omits the 3.7 t of 'other/LOX'")
print("  line items in the ignition-weight table: a 0.13 % effect)")
print("  the row total 7372 m/s is 12.6 m/s below section 3's 7384.5: those are the gains made")
print("  during the two separation coasts (2764.1 -> 2773.9 and 6916.2 -> 6919.0), which no")
print("  engine row owns.")
print("  the S-IVB row 'gains' slightly more than its sea-level-free ideal: the S-IC's true")
print("  average Isp sits between 263 s (sea level) and 304.1 s (vacuum), so the honest")
print("  ascent-loss bracket is ~1.0-1.5 km/s, gravity loss being most of it.")

# drag bound: the vehicle never exceeds 550 m/s below 20 km, and is above 2000 t there
q_cap = max(0.5 * rho_usa(h) * v * v
            for h in [x * 0.05 for x in range(0, 401)]
            for v in [min(550.0, 3.4 * h * 1000 / 60.0) for _ in range(1)])
for cda in (12.0, 28.0):
    a_cap = q_cap * cda / (2000.0 * 1000.0)
    print(f"  drag bound in the dense air (h<20 km, v<550 m/s, m>2000 t, CdA={cda:.0f} m^2): "
          f"a <= {a_cap:.2f} m/s^2 -> loss <= {a_cap*120:.0f} m/s over the 120 s spent below 20 km")
print(f"  Apollo 11 max-q, SP-4029: 735.17 psf = {735.17*47.88026/1000:.2f} kPa; at rho(13.57 km) = "
      f"{rho_usa(13.57):.3f} kg/m^3 that implies v = {math.sqrt(2*735.17*47.88026/rho_usa(13.57)):.0f} m/s")
print("  (the ascent table's velocity column cannot be reconciled with that q and altitude, so")
print("   only q itself is quoted here; the state rows that orbital mechanics confirms are used)")
