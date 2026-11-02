-------------------------- MODULE ChatScrollBounded --------------------------
(***************************************************************************)
(* ChatScroll explored breadth-first to a fixed depth: the regression's    *)
(* bound (regress.py). A behaviour of more than MaxLevel states is cut     *)
(* there, so a config holds "up to the bound" independently of how fast    *)
(* the machine is.                                                         *)
(***************************************************************************)
EXTENDS ChatScroll

CONSTANT MaxLevel

WithinBound == TLCGet("level") < MaxLevel
=============================================================================
