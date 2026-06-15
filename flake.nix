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
          # PNG export (the serve server's /render/<view>.png) drives headless
          # Firefox via Selenium + geckodriver, both wired into the devshell below.
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
            firefox     # headless render target for trmnlp's PNG screenshots
            geckodriver # Selenium WebDriver driver for Firefox
          ];

          # trmnlp renders PNGs (serve's GET /render/<view>.png) through Selenium +
          # headless Firefox. Selenium 4 bundles a prebuilt `selenium-manager` to
          # locate the driver, but that binary can't run on Nix (no FHS loader), so
          # we point Selenium straight at the Nix geckodriver via SE_GECKODRIVER —
          # which short-circuits selenium-manager entirely (see selenium-webdriver
          # service.rb: env_path wins over find_driver_path). geckodriver then finds
          # Firefox on PATH.
          SE_GECKODRIVER = "${pkgs.geckodriver}/bin/geckodriver";

          shellHook = ''
            echo "trmnl-backend devshell"
            echo "  httpyac : $(httpyac --version 2>/dev/null)"
            echo "  wrangler: $(wrangler --version 2>/dev/null)"
            echo "  node    : $(node --version)"
            echo "  trmnlp  : $(trmnlp version 2>/dev/null || echo native gem)"
            echo "  firefox : $(firefox --version 2>/dev/null)"
            echo "  geckodrv: $(geckodriver --version 2>/dev/null | head -1)"
          '';
        };
      };
    };
}
