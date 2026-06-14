{
  description = "trmnl-backend — Cloudflare Workers backend for TRMNL plugins";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = inputs.nixpkgs.lib.systems.flakeExposed;

      perSystem = { pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            httpyac     # run the .http API exploration files
            wrangler    # Cloudflare Workers CLI (dev/deploy)
            nodejs_22   # runtime for wrangler + worker tooling
          ];

          shellHook = ''
            echo "trmnl-backend devshell"
            echo "  httpyac : $(httpyac --version 2>/dev/null)"
            echo "  wrangler: $(wrangler --version 2>/dev/null)"
            echo "  node    : $(node --version)"
          '';
        };
      };
    };
}
