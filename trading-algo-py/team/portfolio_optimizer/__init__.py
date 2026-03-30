"""Portfolio optimizers — HRP, Risk Parity, and Mean-Variance."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


# ============================================================
# Helpers
# ============================================================

def _mean(xs: list[float]) -> float:
    """Arithmetic mean."""
    if not xs:
        return 0.0
    return sum(xs) / len(xs)


def _variance(xs: list[float], ddof: int = 1) -> float:
    """Sample variance."""
    n = len(xs)
    if n <= ddof:
        return 0.0
    mu = _mean(xs)
    return sum((x - mu) ** 2 for x in xs) / (n - ddof)


def _std(xs: list[float], ddof: int = 1) -> float:
    """Sample standard deviation."""
    return math.sqrt(_variance(xs, ddof))


def _pearson(xs: list[float], ys: list[float]) -> float:
    """Pearson correlation coefficient between two equal-length series."""
    n = min(len(xs), len(ys))
    if n < 2:
        return 0.0
    mx, my = _mean(xs[:n]), _mean(ys[:n])
    sx, sy = _std(xs[:n]), _std(ys[:n])
    if sx == 0.0 or sy == 0.0:
        return 0.0
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / (n - 1)
    return max(-1.0, min(1.0, cov / (sx * sy)))


# ============================================================
# Hierarchical Risk Parity
# ============================================================

class HierarchicalRiskParity:
    """Hierarchical Risk Parity (HRP) portfolio optimizer.

    Implements the Lopez de Prado (2016) algorithm:
    1. Compute correlation/distance matrix
    2. Hierarchical clustering (single-linkage)
    3. Quasi-diagonalisation
    4. Recursive bisection for weight allocation
    """

    def optimize(self, returns_map: dict[str, list[float]]) -> dict[str, float]:
        """Compute HRP portfolio weights.

        Args:
            returns_map: Mapping of asset symbol to list of period returns.

        Returns:
            Dict of asset symbol to portfolio weight (sums to ~1.0).
        """
        assets = list(returns_map.keys())
        n = len(assets)

        if n == 0:
            return {}
        if n == 1:
            return {assets[0]: 1.0}

        log.info("HRP optimising portfolio with %d assets", n)

        # Step 1 — correlation and covariance matrices
        names, corr = self._correlation_matrix(returns_map)
        cov = self._covariance_matrix(returns_map)

        # Step 2 — hierarchical clustering
        link = self._cluster_assets(corr)

        # Step 3 — quasi-diagonalise
        sorted_indices = self._quasi_diagonalize(link, n)

        # Step 4 — recursive bisection
        weights_by_idx = self._recursive_bisection(cov, sorted_indices)

        result: dict[str, float] = {}
        for idx, w in weights_by_idx.items():
            result[names[idx]] = w

        # Normalise to sum to 1
        total = sum(result.values())
        if total > 0:
            result = {k: v / total for k, v in result.items()}

        log.info("HRP weights: %s", {k: round(v, 4) for k, v in result.items()})
        return result

    # ----------------------------------------------------------

    def _correlation_matrix(
        self, returns: dict[str, list[float]]
    ) -> tuple[list[str], list[list[float]]]:
        """Build a correlation matrix from return series.

        Returns:
            Tuple of (asset names, NxN correlation matrix).
        """
        names = list(returns.keys())
        n = len(names)
        corr: list[list[float]] = [[0.0] * n for _ in range(n)]
        for i in range(n):
            corr[i][i] = 1.0
            for j in range(i + 1, n):
                c = _pearson(returns[names[i]], returns[names[j]])
                corr[i][j] = c
                corr[j][i] = c
        return names, corr

    def _covariance_matrix(
        self, returns: dict[str, list[float]]
    ) -> list[list[float]]:
        """Build a covariance matrix from return series."""
        names = list(returns.keys())
        n = len(names)
        cov: list[list[float]] = [[0.0] * n for _ in range(n)]
        for i in range(n):
            ri = returns[names[i]]
            mi = _mean(ri)
            for j in range(i, n):
                rj = returns[names[j]]
                mj = _mean(rj)
                length = min(len(ri), len(rj))
                if length <= 1:
                    c = 0.0
                else:
                    c = sum((ri[k] - mi) * (rj[k] - mj) for k in range(length)) / (length - 1)
                cov[i][j] = c
                cov[j][i] = c
        return cov

    def _cluster_assets(
        self, corr_matrix: list[list[float]]
    ) -> list[list[float]]:
        """Single-linkage agglomerative clustering (manual, no scipy).

        Operates on a distance matrix derived from correlation:
            d(i,j) = sqrt(0.5 * (1 - corr(i,j)))

        Returns:
            Linkage matrix as list of [cluster_a, cluster_b, distance, size].
        """
        n = len(corr_matrix)

        # Build condensed distance matrix
        dist: dict[tuple[int, int], float] = {}
        for i in range(n):
            for j in range(i + 1, n):
                d = math.sqrt(0.5 * (1.0 - corr_matrix[i][j]))
                dist[(i, j)] = d

        # Track which original indices belong to each cluster
        cluster_members: dict[int, list[int]] = {i: [i] for i in range(n)}
        active: set[int] = set(range(n))
        next_id = n
        linkage: list[list[float]] = []

        for _ in range(n - 1):
            # Find closest pair among active clusters
            best_d = float("inf")
            best_pair: tuple[int, int] = (-1, -1)
            active_list = sorted(active)
            for ii in range(len(active_list)):
                for jj in range(ii + 1, len(active_list)):
                    a, b = active_list[ii], active_list[jj]
                    # Single-linkage: min distance between any members
                    d = float("inf")
                    for ma in cluster_members[a]:
                        for mb in cluster_members[b]:
                            key = (min(ma, mb), max(ma, mb))
                            if key in dist:
                                d = min(d, dist[key])
                    if d < best_d:
                        best_d = d
                        best_pair = (a, b)

            a, b = best_pair
            new_size = len(cluster_members[a]) + len(cluster_members[b])
            linkage.append([float(a), float(b), best_d, float(new_size)])

            # Merge
            cluster_members[next_id] = cluster_members[a] + cluster_members[b]
            active.discard(a)
            active.discard(b)
            active.add(next_id)
            next_id += 1

        return linkage

    def _quasi_diagonalize(
        self, link: list[list[float]], n: int
    ) -> list[int]:
        """Reorder assets so that correlated assets are adjacent.

        Traverses the linkage tree and returns leaf order.
        """
        # Build tree: node_id -> (left_child, right_child) or leaf
        node_order: dict[int, list[int]] = {}
        for i in range(n):
            node_order[i] = [i]

        for idx, row in enumerate(link):
            left, right = int(row[0]), int(row[1])
            node_id = n + idx
            node_order[node_id] = node_order[left] + node_order[right]

        root = n + len(link) - 1
        return node_order[root]

    def _recursive_bisection(
        self,
        cov: list[list[float]],
        sorted_indices: list[int],
    ) -> dict[int, float]:
        """Allocate weights via recursive bisection.

        Splits sorted assets into halves and allocates inversely
        proportional to cluster variance.
        """
        weights: dict[int, float] = {i: 1.0 for i in sorted_indices}

        cluster_items: list[list[int]] = [sorted_indices]

        while cluster_items:
            next_level: list[list[int]] = []
            for cluster in cluster_items:
                if len(cluster) <= 1:
                    continue
                mid = len(cluster) // 2
                left = cluster[:mid]
                right = cluster[mid:]

                # Cluster variance = sum of covariances within cluster
                var_left = self._cluster_variance(cov, left)
                var_right = self._cluster_variance(cov, right)

                # Allocate inversely proportional to variance
                total_var = var_left + var_right
                if total_var == 0:
                    alpha = 0.5
                else:
                    alpha = 1.0 - var_left / total_var

                for i in left:
                    weights[i] *= alpha
                for i in right:
                    weights[i] *= (1.0 - alpha)

                if len(left) > 1:
                    next_level.append(left)
                if len(right) > 1:
                    next_level.append(right)

            cluster_items = next_level

        return weights

    @staticmethod
    def _cluster_variance(cov: list[list[float]], indices: list[int]) -> float:
        """Compute the variance of an equal-weight portfolio of the given assets."""
        n = len(indices)
        if n == 0:
            return 0.0
        w = 1.0 / n
        var = 0.0
        for i in indices:
            for j in indices:
                var += w * w * cov[i][j]
        return var


# ============================================================
# Risk Parity (Equal Risk Contribution)
# ============================================================

class RiskParityOptimizer:
    """Equal risk contribution portfolio optimizer.

    Iteratively adjusts weights so each asset contributes equally
    to portfolio risk (measured by variance contribution).
    """

    def __init__(self, max_iterations: int = 1000, tolerance: float = 1e-8) -> None:
        self.max_iterations = max_iterations
        self.tolerance = tolerance

    def optimize(self, returns_map: dict[str, list[float]]) -> dict[str, float]:
        """Compute equal-risk-contribution portfolio weights.

        Args:
            returns_map: Mapping of asset symbol to list of period returns.

        Returns:
            Dict of asset symbol to portfolio weight (sums to ~1.0).
        """
        assets = list(returns_map.keys())
        n = len(assets)

        if n == 0:
            return {}
        if n == 1:
            return {assets[0]: 1.0}

        log.info("Risk Parity optimising portfolio with %d assets", n)

        # Build covariance matrix
        cov = HierarchicalRiskParity()._covariance_matrix(returns_map)

        # Start with equal weights
        weights = [1.0 / n] * n
        target_risk = 1.0 / n  # each asset should contribute this fraction

        for iteration in range(self.max_iterations):
            # Portfolio variance
            port_var = 0.0
            for i in range(n):
                for j in range(n):
                    port_var += weights[i] * weights[j] * cov[i][j]

            if port_var <= 0:
                break

            port_std = math.sqrt(port_var)

            # Marginal risk contribution for each asset
            mrc: list[float] = []
            for i in range(n):
                mc_i = sum(weights[j] * cov[i][j] for j in range(n)) / port_std
                mrc.append(mc_i)

            # Risk contribution: w_i * MRC_i
            rc = [weights[i] * mrc[i] for i in range(n)]
            total_rc = sum(rc)

            if total_rc <= 0:
                break

            # Fractional risk contribution
            frc = [r / total_rc for r in rc]

            # Check convergence
            max_dev = max(abs(frc[i] - target_risk) for i in range(n))
            if max_dev < self.tolerance:
                log.debug("Risk Parity converged at iteration %d", iteration)
                break

            # Update weights: scale by target/actual risk contribution
            new_weights: list[float] = []
            for i in range(n):
                if frc[i] > 0:
                    new_weights.append(weights[i] * (target_risk / frc[i]) ** 0.5)
                else:
                    new_weights.append(weights[i])

            # Normalise
            total_w = sum(new_weights)
            if total_w > 0:
                weights = [w / total_w for w in new_weights]

        result = {assets[i]: weights[i] for i in range(n)}
        log.info("Risk Parity weights: %s", {k: round(v, 4) for k, v in result.items()})
        return result


# ============================================================
# Mean-Variance Optimiser (Markowitz)
# ============================================================

class MeanVarianceOptimizer:
    """Mean-Variance portfolio optimizer (Markowitz).

    Uses a simple gradient-based approach to find the minimum-variance
    portfolio (or the tangent portfolio when a target return is specified).
    No external optimisation library required.
    """

    def __init__(
        self,
        max_iterations: int = 5000,
        learning_rate: float = 0.01,
        tolerance: float = 1e-8,
    ) -> None:
        self.max_iterations = max_iterations
        self.learning_rate = learning_rate
        self.tolerance = tolerance

    def optimize(
        self,
        returns_map: dict[str, list[float]],
        target_return: float | None = None,
    ) -> dict[str, float]:
        """Compute mean-variance optimal portfolio weights.

        If *target_return* is ``None``, finds the global minimum-variance
        portfolio.  Otherwise, finds the minimum-variance portfolio that
        achieves at least the target return (long-only).

        Args:
            returns_map: Mapping of asset symbol to list of period returns.
            target_return: Optional minimum target portfolio return.

        Returns:
            Dict of asset symbol to portfolio weight (sums to ~1.0).
        """
        assets = list(returns_map.keys())
        n = len(assets)

        if n == 0:
            return {}
        if n == 1:
            return {assets[0]: 1.0}

        log.info(
            "Mean-Variance optimising portfolio with %d assets (target_return=%s)",
            n, target_return,
        )

        # Expected returns and covariance
        mu = [_mean(returns_map[a]) for a in assets]
        cov = HierarchicalRiskParity()._covariance_matrix(returns_map)

        # Start with equal weights
        weights = [1.0 / n] * n

        for iteration in range(self.max_iterations):
            # Gradient of portfolio variance w.r.t. weights: 2 * Cov @ w
            grad: list[float] = []
            for i in range(n):
                g = 2.0 * sum(cov[i][j] * weights[j] for j in range(n))
                grad.append(g)

            # If target_return specified, add penalty for being below target
            if target_return is not None:
                port_return = sum(weights[i] * mu[i] for i in range(n))
                shortfall = target_return - port_return
                if shortfall > 0:
                    # Penalise: push weights toward higher-return assets
                    penalty_strength = 100.0
                    for i in range(n):
                        grad[i] -= penalty_strength * mu[i]

            # Update weights
            new_weights: list[float] = []
            for i in range(n):
                w = weights[i] - self.learning_rate * grad[i]
                w = max(w, 0.0)  # long-only constraint
                new_weights.append(w)

            # Normalise
            total_w = sum(new_weights)
            if total_w > 0:
                new_weights = [w / total_w for w in new_weights]
            else:
                new_weights = [1.0 / n] * n

            # Check convergence
            max_change = max(abs(new_weights[i] - weights[i]) for i in range(n))
            weights = new_weights

            if max_change < self.tolerance:
                log.debug("Mean-Variance converged at iteration %d", iteration)
                break

        result = {assets[i]: weights[i] for i in range(n)}
        log.info("Mean-Variance weights: %s", {k: round(v, 4) for k, v in result.items()})
        return result


__all__ = [
    "HierarchicalRiskParity",
    "RiskParityOptimizer",
    "MeanVarianceOptimizer",
]
