{
  description = "trmnl-backend — Cloudflare Workers backend for TRMNL plugins";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = inputs.nixpkgs.lib.systems.flakeExposed;

      perSystem = { pkgs, ... }:
        let
          # trmnlp (the trmnl_preview gem) isn't in nixpkgs, so build it from a
          # bundix-generated lockset in nix/trmnlp/. Regenerate after a version
          # bump with:  cd nix/trmnlp && nix run nixpkgs#bundix -- --lock
          # Core commands (serve/push/lint) are pure Ruby; `build --png` also
          # needs a browser + geckodriver, which aren't wired in here.
          trmnlp = pkgs.bundlerApp {
            pname = "trmnl_preview";
            gemdir = ./nix/trmnlp;
            exes = [ "trmnlp" ];
            ruby = pkgs.ruby_3_4;
          };
        in
        {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            httpyac     # run the .http API exploration files
            wrangler    # Cloudflare Workers CLI (dev/deploy)
            nodejs_22   # runtime for wrangler + worker tooling
            trmnlp      # TRMNL plugin dev/preview/push (native gem)
            imagemagick # used by trmnlp's mini_magick for PNG output
          ];

          shellHook = ''
            echo "trmnl-backend devshell"
            echo "  httpyac : $(httpyac --version 2>/dev/null)"
            echo "  wrangler: $(wrangler --version 2>/dev/null)"
            echo "  node    : $(node --version)"
            echo "  trmnlp  : $(trmnlp version 2>/dev/null || echo native gem)"
          '';
        };
      };
    };
}
