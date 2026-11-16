# Third-party software

Ephor's off-site backup worker runs Restic 0.19.1 from the official
`docker.io/restic/restic` image, pinned to multi-platform manifest digest
`sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510`.
The worker downloads the image directly from its publisher; Ephor does not copy
Restic source into its daemon or bundle the container layers in this repository.

Restic is copyright Alexander Neumann and contributors, licensed under BSD
2-Clause. Its license is reproduced in [docs/licenses/restic.txt](docs/licenses/restic.txt).
Source: <https://github.com/restic/restic/tree/v0.19.1>.
The image also contains Alpine packages and Restic's dependencies under their own
licenses. If distributing a preloaded image or vendoring the executable, include
those dependency notices as well as Restic's license with that distribution.

This notice does not select a license for Ephor itself.
