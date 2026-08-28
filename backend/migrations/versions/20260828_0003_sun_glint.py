"""Add predicted sun-glint geometry to satellite passes.

Revision ID: 20260828_0003
Revises: 20260827_0002
Create Date: 2026-08-28
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20260828_0003"
down_revision = "20260827_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("satellite_passes", sa.Column("solar_elevation_deg", sa.Float(), nullable=False, server_default="0"))
    op.add_column("satellite_passes", sa.Column("solar_azimuth_deg", sa.Float(), nullable=False, server_default="0"))
    op.add_column("satellite_passes", sa.Column("satellite_elevation_deg", sa.Float(), nullable=False, server_default="0"))
    op.add_column("satellite_passes", sa.Column("satellite_azimuth_deg", sa.Float(), nullable=False, server_default="0"))
    op.add_column("satellite_passes", sa.Column("glint_angle_deg", sa.Float(), nullable=False, server_default="180"))
    op.add_column("satellite_passes", sa.Column("glint_risk", sa.String(length=16), nullable=False, server_default="minimal"))


def downgrade() -> None:
    op.drop_column("satellite_passes", "glint_risk")
    op.drop_column("satellite_passes", "glint_angle_deg")
    op.drop_column("satellite_passes", "satellite_azimuth_deg")
    op.drop_column("satellite_passes", "satellite_elevation_deg")
    op.drop_column("satellite_passes", "solar_azimuth_deg")
    op.drop_column("satellite_passes", "solar_elevation_deg")
