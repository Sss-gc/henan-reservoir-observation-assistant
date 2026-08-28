"""Add Sentinel-2 water-index metrics.

Revision ID: 20260827_0002
Revises: 20260827_0001
Create Date: 2026-08-27
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20260827_0002"
down_revision = "20260827_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_water_metrics",
        sa.Column("product_record_id", sa.String(length=320), nullable=False),
        sa.Column("computed_at", sa.DateTime(), nullable=False),
        sa.Column("method", sa.String(length=160), nullable=False),
        sa.Column("valid_pixels", sa.Integer(), nullable=False),
        sa.Column("clear_pixels", sa.Integer(), nullable=False),
        sa.Column("ndwi_mean", sa.Float(), nullable=False),
        sa.Column("mndwi_mean", sa.Float(), nullable=False),
        sa.Column("ndwi_water_pixels", sa.Integer(), nullable=False),
        sa.Column("mndwi_water_pixels", sa.Integer(), nullable=False),
        sa.Column("ndwi_water_area_km2", sa.Float(), nullable=False),
        sa.Column("mndwi_water_area_km2", sa.Float(), nullable=False),
        sa.Column("estimated_water_area_km2", sa.Float(), nullable=False),
        sa.Column("reservoir_reference_area_km2", sa.Float(), nullable=False),
        sa.Column("clear_observation_ratio", sa.Float(), nullable=False),
        sa.Column("area_change_from_reference_pct", sa.Float(), nullable=False),
        sa.Column("method_disagreement_pct", sa.Float(), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["product_record_id"], ["imagery_products.id"]),
        sa.PrimaryKeyConstraint("product_record_id"),
    )
    op.create_index(
        op.f("ix_product_water_metrics_computed_at"),
        "product_water_metrics",
        ["computed_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_product_water_metrics_computed_at"), table_name="product_water_metrics")
    op.drop_table("product_water_metrics")
